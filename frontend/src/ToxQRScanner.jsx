import React, {useEffect,useRef,useState} from "react";
import {Button, Typography} from "antd";
import {CameraOutlined, ArrowLeftOutlined} from "@ant-design/icons";
import {parseScannedToxId} from "./tox_qr.js";

/** Camera is started only while the user is on this explicitly opened view.
 * ZXing runs locally, and both the camera stream and decoder stop on exit.
 */
export default function ToxQRScanner({onScan,onBack}){
  const videoRef=useRef(null);
  const controlsRef=useRef(null);
  const acceptedRef=useRef(false);
  const [state,setState]=useState("starting");
  const [hint,setHint]=useState("");

  useEffect(()=>{
    let active=true;
    let controls=null;
    async function start(){
      try{
        if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){
          throw new Error("当前浏览器无法使用摄像头，请通过 HTTPS 打开后手动输入 Tox ID");
        }
        const {BrowserQRCodeReader}=await import("@zxing/browser");
        if(!active||!videoRef.current)return;
        const reader=new BrowserQRCodeReader();
        controls=await reader.decodeFromConstraints(
          {audio:false,video:{facingMode:{ideal:"environment"}}},
          videoRef.current,
          (result,_error,readerControls)=>{
            if(!active||acceptedRef.current||!result)return;
            const toxId=parseScannedToxId(result.getText());
            if(!toxId){
              setHint("未识别到有效的 76 位 Tox ID，请扫描好友的身份二维码。");
              return;
            }
            acceptedRef.current=true;
            readerControls.stop();
            onScan(toxId);
          }
        );
        if(!active||acceptedRef.current)controls.stop();
        else{
          controlsRef.current=controls;
          setState("ready");
        }
      }catch(error){
        if(!active)return;
        const reason=error?.name;
        setState("error");
        setHint(reason==="NotAllowedError"||reason==="PermissionDeniedError"
          ?"未获得摄像头权限，请到系统设置中允许访问，或手动输入 Tox ID。":
          reason==="NotFoundError"
            ?"没有找到可用的摄像头，请手动输入 Tox ID。":
            error?.message||"扫码启动失败，请手动输入 Tox ID。");
      }
    }
    start();
    return()=>{
      active=false;
      try{controlsRef.current?.stop()}catch{}
      try{controls?.stop()}catch{}
      controlsRef.current=null;
      // Be defensive if the decoder failed while attaching a stream.
      const video=videoRef.current;
      const stream=video?.srcObject;
      if(stream&&typeof stream.getTracks==="function"){
        for(const track of stream.getTracks())track.stop();
        video.srcObject=null;
      }
    };
  },[onScan]);

  return <section className="wt-qr-scanner" aria-label="扫描好友 Tox 二维码">
    <div className="wt-qr-video-frame">
      <video ref={videoRef} autoPlay muted playsInline
        aria-label="实时摄像头画面" className="wt-qr-video"/>
      <div className="wt-qr-focus" aria-hidden="true">
        <span/><span/><span/><span/>
      </div>
      {state==="starting"&&<span className="wt-qr-progress">
        <CameraOutlined/> 正在开启摄像头…
      </span>}
      {state==="error"&&<span className="wt-qr-progress">摄像头不可用</span>}
    </div>
    <Typography.Paragraph className="wt-qr-instruction">
      请将好友的 Tox 二维码放入扫描框内，识别后会自动填入 ID。
    </Typography.Paragraph>
    {!!hint&&<Typography.Paragraph type={state==="error"?"danger":"secondary"}
      className="wt-qr-hint" role="status">{hint}</Typography.Paragraph>}
    <Typography.Text type="secondary" className="wt-qr-privacy">
      二维码只在当前设备识别，不会上传视频。
    </Typography.Text>
    <Button block icon={<ArrowLeftOutlined/>} onClick={onBack}
      className="wt-qr-back">返回手动输入</Button>
  </section>;
}
