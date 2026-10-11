"""Native Tox FILE_KIND_DATA and encrypted seven-day disk file inbox.

Incoming offers automatically accept while the account has no open browser
WebSocket, so browser closure does not interrupt receipt from online Tox peers.
Native sender and VPS Toxcore must still be mutually online.
"""
from __future__ import annotations
import ctypes as C
import os
import time
import uuid
from dataclasses import dataclass

U8=C.c_uint8
U32=C.c_uint32
PTR=C.c_void_p
BUF=C.POINTER(U8)
ERR=C.POINTER(C.c_int)
MAX_FILE=5*1024*1024
MAX_ACTIVE=4
TTL=15*60
RecvCB=C.CFUNCTYPE(None,PTR,U32,U32,U32,C.c_uint64,BUF,C.c_size_t,PTR)
RecvChunkCB=C.CFUNCTYPE(None,PTR,U32,U32,C.c_uint64,BUF,C.c_size_t,PTR)
RequestCB=C.CFUNCTYPE(None,PTR,U32,U32,C.c_uint64,C.c_size_t,PTR)
ControlCB=C.CFUNCTYPE(None,PTR,U32,U32,C.c_int,PTR)


def safe_filename(value):
    # Never trust remote paths, separators or control chars.
    name=value.replace("\\","/").split("/")[-1]
    name="".join(c for c in name if c.isprintable() and c not in "/\\:\x00")
    name=name.strip(" .")
    if not name or len(name.encode("utf-8"))>220:
        raise ValueError("附件名称为空或超过长度限制")
    return name


@dataclass
class Transfer:
    id: str
    friend: int
    file_number: int
    direction: str
    name: str
    size: int
    state: str
    when: float
    document: object | None = None
    progress: int = 0
    public_key: str = ""


class FileTransfers:
    def __init__(self, session):
        self.session=session
        self.items={}
        self.disk=None
        self.uid=None
        # The owning session manager installs a socket-aware policy.
        self.should_auto_accept=lambda:False
        self.bind_native()

    def bind_native(self):
        b=self.session.core._fn
        self.send_native=b("tox_file_send",U32,PTR,U32,U32,C.c_uint64,BUF,BUF,C.c_size_t,ERR)
        self.send_chunk=b("tox_file_send_chunk",C.c_bool,PTR,U32,U32,C.c_uint64,BUF,C.c_size_t,ERR)
        self.control_native=b("tox_file_control",C.c_bool,PTR,U32,U32,C.c_int,ERR)
        self.cb_recv=b("tox_callback_file_recv",None,PTR,RecvCB)
        self.cb_chunk=b("tox_callback_file_recv_chunk",None,PTR,RecvChunkCB)
        self.cb_request=b("tox_callback_file_chunk_request",None,PTR,RequestCB)
        self.cb_control=b("tox_callback_file_recv_control",None,PTR,ControlCB)

    def attach(self):
        # Callback references live as long as their native Tox session.
        self._receive=RecvCB(self._on_receive)
        self._receive_chunk=RecvChunkCB(self._on_receive_chunk)
        self._request=RequestCB(self._on_chunk_request)
        self._control=ControlCB(self._on_control)
        self.cb_recv(self.session.tox,self._receive)
        self.cb_chunk(self.session.tox,self._receive_chunk)
        self.cb_request(self.session.tox,self._request)
        self.cb_control(self.session.tox,self._control)

    def _emit(self,item):
        self.session._emit({"type":"file", **self._public(item)})

    def _public(self,item):
        return {"id":item.id,"direction":item.direction,"public_key":item.public_key,
                "name":item.name,"size":item.size,"state":item.state,"progress":item.progress}

    def _active_count(self):
        return sum(x.state in ("offered","waiting","receiving","sending") for x in self.items.values())

    def prune(self):
        now=time.time()
        for uid,item in list(self.items.items()):
            if now-item.when>TTL:
                if item.state in ("offered","waiting","receiving","sending"):
                    self._native_cancel(item)
                    if item.document is not None:
                        item.document.abort()
                del self.items[uid]
        # Also cap completed buffers. A peer can send unlimited sequential
        # files; keep at most eight temporary items per account in memory.
        while len(self.items)>8:
            finished=[x for x in self.items.values()
                      if x.state in ("completed","cancelled","failed")]
            if not finished:
                break
            oldest=min(finished,key=lambda x:x.when)
            del self.items[oldest.id]

    def _native_cancel(self,item):
        err=C.c_int()
        try:self.control_native(self.session.tox,item.friend,item.file_number,2,C.byref(err))
        except Exception:pass

    def get(self,ident):
        self.prune()
        row=self.items.get(ident)
        if row is None:raise ValueError("附件不存在或已过期")
        return row

    def _find(self,friend,file_number,direction):
        return next((v for v in self.items.values() if v.friend==friend and
                     v.file_number==file_number and v.direction==direction and
                     v.state in ("offered","waiting","receiving","sending")),None)

    def send(self,key,name,document):
        name=safe_filename(name)
        if (not getattr(document,"complete",False) or
                not 1<=document.size<=MAX_FILE or
                document.uid!=self.uid or document.direction!="outgoing" or
                document.name!=name):
            raise ValueError("附件未完成硬盘加密暂存或身份不匹配")
        with self.session.lock:
            self.session._require_live()
            self.prune()
            if self._active_count()>=MAX_ACTIVE:raise ValueError("当前附件传输过多，请稍后再试")
            if len(key)!=64:
                raise ValueError("好友公钥长度不正确")
            try:
                key_bytes=bytes.fromhex(key)
            except ValueError as exc:
                raise ValueError("好友公钥不是十六进制") from exc
            pub=self.session.friend_by_key
            err=C.c_int()
            friend=pub(self.session.tox,(U8*32).from_buffer_copy(key_bytes),C.byref(err))
            if err.value:raise ValueError("好友不存在")
            err.value=0
            online=self.session.friend_connection(self.session.tox,friend,C.byref(err))
            if err.value or online==0:raise ValueError("好友当前离线，不能发附件")
            encoded=name.encode("utf-8")
            filename=(U8*len(encoded)).from_buffer_copy(encoded)
            err.value=0
            n=self.send_native(self.session.tox,friend,0,document.size,None,filename,len(encoded),C.byref(err))
            if err.value:raise ValueError("原生 Tox 附件发送失败（错误码 %d）"%err.value)
            item=Transfer(document.id,friend,int(n),"outgoing",name,document.size,
                          "waiting",time.time(),document,0,key.upper())
            self.items[item.id]=item
            self._emit(item)
            return self._public(item)

    def friend_disconnected(self,friend_number):
        for item in self.items.values():
            if item.friend==friend_number and item.state in ("offered","waiting","receiving","sending"):
                item.state="failed"
                if item.document is not None:
                    item.document.abort()
                    item.document=None
                self._emit(item)

    def list(self):
        with self.session.lock:
            self.prune()
            active={item.id:self._public(item) for item in self.items.values()}
            # Merge completed encrypted files from disk; survives Tox/VPS restart.
            if self.disk is not None and self.uid is not None:
                for archived in self.disk.list_received(self.uid):
                    if archived["id"] not in active:
                        active[archived["id"]]=archived
            return list(active.values())

    def control(self,ident,accept):
        with self.session.lock:
            item=self.get(ident)
            if item.direction!="incoming" or item.state!="offered":
                raise ValueError("此附件不在等待接收状态")
            err=C.c_int()
            if accept:
                if self.disk is None or self.uid is None:
                    raise ValueError("磁盘附件暂存服务不可用")
                item.document=self.disk.begin(self.uid,item.name,expected=item.size,
                                              direction="incoming",ident=item.id,
                                              public_key=item.public_key)
            ok=self.control_native(self.session.tox,item.friend,item.file_number,0 if accept else 2,C.byref(err))
            if not ok or err.value:
                if item.document is not None:
                    item.document.abort()
                    item.document=None
                raise ValueError("Tox 文件控制失败（错误码 %d）"%err.value)
            item.state="receiving" if accept else "cancelled"
            item.when=time.time()
            self._emit(item)
            return self._public(item)

    def download(self,ident):
        """Compatibility helper for existing callers; HTTP now streams blocks."""
        if not self.disk or not self.uid:
            raise ValueError("附件磁盘存储不可用")
        name,_,chunks=self.disk.download(self.uid,ident)
        return name,b"".join(chunks)

    def _on_receive(self,_tox,friend,file_number,kind,size,filename,length,_user):
        item=None
        try:
            self.prune()
            if kind!=0 or not 1<=size<=MAX_FILE or self._active_count()>=MAX_ACTIVE:
                self.control_native(self.session.tox,friend,file_number,2,C.byref(C.c_int()))
                return
            name=safe_filename(C.string_at(filename,length).decode("utf-8","replace"))
            key=self.session._friend_key(int(friend))
            item=Transfer(uuid.uuid4().hex,int(friend),int(file_number),"incoming",
                          name,int(size),"offered",time.time(),None,0,key)
            self.items[item.id]=item
            if self.should_auto_accept():
                # A disconnected browser cannot click Accept; use the same
                # bounded, authenticated-disk path as manual reception.
                self.control(item.id,True)
            else:
                self._emit(item)
        except Exception as exc:
            if item is not None:
                self.items.pop(item.id,None)
                if item.document is not None:
                    item.document.abort()
            print("Tox file offer handling error:",type(exc).__name__,flush=True)
            try:self.control_native(self.session.tox,friend,file_number,2,C.byref(C.c_int()))
            except Exception:pass

    def _on_receive_chunk(self,_tox,friend,file_number,position,data,length,_user):
        try:
            item=self._find(friend,file_number,"incoming")
            if item is None or item.state!="receiving" or item.document is None:return
            if length==0:
                if position==item.size and item.progress==item.size:
                    try:
                        item.document.finish()
                        item.state="completed"
                    except (OSError,ValueError):
                        item.document.abort()
                        item.document=None
                        item.state="failed"
                else:
                    item.state="failed"
                    item.document.abort()
                    item.document=None
                self._emit(item)
                return
            if position!=item.progress or position+length>item.size:
                item.state="failed"
                item.document.abort()
                item.document=None
                self._native_cancel(item);self._emit(item)
                return
            item.document.write(C.string_at(data,length))
            item.progress+=length
            item.when=time.time()
            if item.progress==item.size:self._emit(item)
        except Exception as exc:
            if item is not None:
                item.state="failed"
                if item.document is not None:
                    item.document.abort()
                    item.document=None
                self._native_cancel(item)
                self._emit(item)
            print("Tox file receiving chunk failed:",type(exc).__name__,flush=True)

    def _on_chunk_request(self,_tox,friend,file_number,position,length,_user):
        try:
            item=self._find(friend,file_number,"outgoing")
            if not item or item.document is None:return
            if length==0:
                item.state="completed";self._emit(item);return
            if length>64*1024 or position+length>item.size:return
            data=item.document.read(position,length)
            buf=(U8*len(data)).from_buffer_copy(data)
            err=C.c_int()
            ok=self.send_chunk(self.session.tox,friend,file_number,position,buf,len(data),C.byref(err))
            if not ok or err.value:
                item.state="failed"
                if item.document is not None:
                    item.document.abort()
                    item.document=None
                self._emit(item)
                return
            item.state="sending";item.progress=max(item.progress,int(position+length))
            item.when=time.time()
            if item.progress==item.size:self._emit(item)
        except Exception as exc:
            print("Tox file sending chunk failed:",type(exc).__name__,flush=True)

    def _on_control(self,_tox,friend,file_number,control,_user):
        try:
            item=self._find(friend,file_number,"outgoing")
            if not item:item=self._find(friend,file_number,"incoming")
            if item is None:return
            if control==2:
                item.state="cancelled"
                if item.document is not None and not item.document.complete:
                    item.document.abort()
                    item.document=None
            elif control==1:
                item.state="waiting"
            elif control==0 and item.direction=="outgoing":
                item.state="sending"
            item.when=time.time()
            self._emit(item)
        except Exception as exc:
            print("Tox file control handling failed:",type(exc).__name__,flush=True)
