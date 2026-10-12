import React, {useEffect,useState} from "react";
import {FileOutlined} from "@ant-design/icons";

/**
 * Ant Design X FileCard's name-only image tile does not have image bytes or a
 * thumbnail URL. Preview the prepared File itself, including locally
 * compressed WebP photos, without sending anything to the server.
 *
 * The object URL exists only while the matching file is being previewed.
 * React revokes it when the modal is closed, the file changes or the page
 * unmounts. Never use the camera's original filename as an image URL.
 */
export function PreparedAttachmentPreview({file}) {
  const [preview,setPreview]=useState(null);
  const [imageFailed,setImageFailed]=useState(false);
  const isImage=/^image\/(?:jpeg|png|webp|gif)$/i.test(file?.type||"");
  useEffect(()=>{
    setPreview(null);
    setImageFailed(false);
    if(!file||!/^image\/(?:jpeg|png|webp|gif)$/i.test(file.type||""))return;
    const url=URL.createObjectURL(file);
    setPreview(url);
    return()=>URL.revokeObjectURL(url);
  },[file]);

  if(!file)return null;
  return <div className="wt-prepared-file" role="group" aria-label="待发送附件">
    {isImage&&preview&&!imageFailed
      ? <img className="wt-prepared-image" src={preview} alt="待发送图片预览"
          onError={()=>setImageFailed(true)}/>
      : <div className="wt-prepared-file-icon" aria-hidden="true"><FileOutlined/></div>}
    {isImage&&imageFailed&&<span className="wt-prepared-preview-error">
      此设备暂时无法显示缩略图，仍可作为附件发送
    </span>}
    <span className="wt-prepared-filename" title={file.name}>{file.name}</span>
  </div>;
}
