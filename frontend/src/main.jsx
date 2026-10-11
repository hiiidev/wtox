import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./style.css";
import App from "./App.jsx";

class ErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={broken:false}}
  static getDerivedStateFromError(){return {broken:true}}
  componentDidCatch(error){console.error("wtox React rendering failed:",error)}
  render(){
    if(!this.state.broken)return this.props.children;
    return <div className="wtox-error-page" role="alert">
      <img src="/logo.svg" alt="wtox logo" width="88" height="88"/>
      <h1>聊天界面加载失败</h1>
      <p>React 组件出现异常，现有 Tox 身份和本地聊天记录不会因此被清除。</p>
      <button onClick={()=>location.reload()}>重新载入</button>
      <p>如果持续失败，请检查浏览器开发者工具的 Console 和 Network，以及服务器容器日志。</p>
    </div>;
  }
}
createRoot(document.getElementById("root")).render(
  <ErrorBoundary><App/></ErrorBoundary>
);
