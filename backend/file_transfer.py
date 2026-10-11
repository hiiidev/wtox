"""Bounded in-memory, native Toxcore FILE_KIND_DATA transfers.

A deliberately small, online-only implementation. Incoming offers require a
browser click to accept. No unbounded allocation, automatic file execution,
path writes, database persistence or restart/resume support.
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
    payload: bytes | bytearray | None = None
    progress: int = 0
    public_key: str = ""


class FileTransfers:
    def __init__(self, session):
        self.session=session
        self.items={}
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

    def send(self,key,name,data):
        name=safe_filename(name)
        if not isinstance(data,bytes) or not 1<=len(data)<=MAX_FILE:
            raise ValueError("附件必须为 1 字节至 5 MiB")
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
            n=self.send_native(self.session.tox,friend,0,len(data),None,filename,len(encoded),C.byref(err))
            if err.value:raise ValueError("原生 Tox 附件发送失败（错误码 %d）"%err.value)
            item=Transfer(uuid.uuid4().hex,friend,int(n),"outgoing",name,len(data),"waiting",time.time(),data,0,key.upper())
            self.items[item.id]=item
            self._emit(item)
            return self._public(item)

    def friend_disconnected(self,friend_number):
        for item in self.items.values():
            if item.friend==friend_number and item.state in ("offered","waiting","receiving","sending"):
                item.state="failed"
                item.payload=None
                self._emit(item)

    def list(self):
        with self.session.lock:
            self.prune()
            return [self._public(item) for item in self.items.values()]

    def control(self,ident,accept):
        with self.session.lock:
            item=self.get(ident)
            if item.direction!="incoming" or item.state!="offered":
                raise ValueError("此附件不在等待接收状态")
            err=C.c_int()
            if accept:
                item.payload=bytearray(item.size)
            ok=self.control_native(self.session.tox,item.friend,item.file_number,0 if accept else 2,C.byref(err))
            if not ok or err.value:raise ValueError("Tox 文件控制失败（错误码 %d）"%err.value)
            item.state="receiving" if accept else "cancelled"
            item.when=time.time()
            if not accept:item.payload=None
            self._emit(item)
            return self._public(item)

    def download(self,ident):
        with self.session.lock:
            item=self.get(ident)
            if item.direction!="incoming" or item.state!="completed" or item.payload is None:
                raise ValueError("附件尚未接收完成")
            return item.name,bytes(item.payload)

    def _on_receive(self,_tox,friend,file_number,kind,size,filename,length,_user):
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
            self._emit(item)
        except Exception as exc:
            print("Tox file offer handling error:",type(exc).__name__,flush=True)
            try:self.control_native(self.session.tox,friend,file_number,2,C.byref(C.c_int()))
            except Exception:pass

    def _on_receive_chunk(self,_tox,friend,file_number,position,data,length,_user):
        try:
            item=self._find(friend,file_number,"incoming")
            if item is None or item.state!="receiving" or item.payload is None:return
            if length==0:
                if position==item.size and item.progress==item.size:
                    item.state="completed"
                else:
                    item.state="failed";item.payload=None
                self._emit(item)
                return
            if position!=item.progress or position+length>item.size:
                item.state="failed";item.payload=None
                self._native_cancel(item);self._emit(item)
                return
            item.payload[position:position+length]=C.string_at(data,length)
            item.progress+=length
            item.when=time.time()
            # Keep UI update volume modest.
            if item.progress==item.size:self._emit(item)
        except Exception as exc:
            print("Tox file receiving chunk failed:",type(exc).__name__,flush=True)

    def _on_chunk_request(self,_tox,friend,file_number,position,length,_user):
        try:
            item=self._find(friend,file_number,"outgoing")
            if not item or item.payload is None:return
            if length==0:
                item.state="completed";item.payload=None;self._emit(item);return
            if position+length>item.size:return
            data=item.payload[position:position+length]
            buf=(U8*len(data)).from_buffer_copy(data)
            err=C.c_int()
            ok=self.send_chunk(self.session.tox,friend,file_number,position,buf,len(data),C.byref(err))
            if not ok or err.value:
                item.state="failed";item.payload=None;self._emit(item)
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
                item.state="cancelled";item.payload=None
            elif control==1:
                item.state="waiting"
            elif control==0 and item.direction=="outgoing":
                item.state="sending"
            item.when=time.time()
            self._emit(item)
        except Exception as exc:
            print("Tox file control handling failed:",type(exc).__name__,flush=True)
