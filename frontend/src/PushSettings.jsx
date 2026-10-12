import React, {useEffect, useRef, useState} from "react";
import {Badge, Button, Card, Space, Typography} from "antd";
import {postJson} from "./api.js";
import {
  preparePush, savePushSubscription, disablePush,
  isIPhoneOrIPad, isStandalone
} from "./push_client.js";

export default function PushSettings({userId}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [detail, setDetail] = useState("");
  const context = useRef(null);

  useEffect(() => {
    let live = true;
    context.current = null;
    setReady(false);
    setEnabled(false);
    if (!userId || !isStandalone()) return undefined;
    (async () => {
      try {
        const prepared = await preparePush();
        if (!live) return;
        context.current = prepared;
        // Restore existing subscription for the currently logged-in Tox identity.
        if (prepared.subscription && Notification.permission === "granted") {
          await savePushSubscription(prepared.subscription);
          if (!live) return;
          setEnabled(true);
        }
        setReady(true);
        setDetail("");
      } catch (error) {
        if (live) setDetail(error.message);
      }
    })();
    return () => {live = false; context.current = null;};
  }, [userId]);

  async function enable() {
    if (!context.current || busy) return;
    setBusy(true);
    setDetail("");
    try {
      const {registration, applicationServerKey} = context.current;
      // Important for iOS: subscribe() starts synchronously in the click handler.
      const promise = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
      const subscription = await promise;
      await savePushSubscription(subscription);
      context.current.subscription = subscription;
      setEnabled(true);
      setDetail("离线推送已开启，锁屏后可以接收测试通知");
    } catch (error) {
      setDetail("订阅失败：" + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!context.current || busy) return;
    setBusy(true);
    try {
      await disablePush(context.current.registration);
      context.current.subscription = null;
      setEnabled(false);
      setDetail("离线推送已关闭");
    } catch (error) {
      setDetail("关闭失败：" + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const result = await postJson("/api/push/test");
      setDetail(result.sent
        ? "已向推送服务提交测试通知，请检查设备通知中心"
        : "未找到可用订阅，请重新开启离线推送");
    } catch (error) {
      setDetail("测试发送失败：" + error.message);
    } finally {
      setBusy(false);
    }
  }

  // Keep ordinary browser settings uncluttered: show Web Push only when
  // launched as an installed iOS / Android (or desktop) PWA.
  if (!userId || !isStandalone()) return null;
  return <Card size="small" title="离线推送（PWA）" className="wt-settings-card"
    extra={<Badge status={enabled?"success":ready?"default":"warning"}
      text={enabled?"已启用":ready?"未启用":"未就绪"}/>}>
    <Typography.Paragraph type="secondary">
      {isIPhoneOrIPad() ? "iPhone / iPad 已在主屏幕模式运行。" : "已安装的 PWA 可在此启用通知。"}
      VPS 上的 Toxcore 收到新消息或好友请求时，可以在锁屏或关闭应用后发送提醒。
      通知不会包含聊天正文。
    </Typography.Paragraph>
    <Space wrap>
      <Button type={enabled ? "default" : "primary"}
        disabled={!ready || busy}
        loading={busy}
        onClick={enabled ? disable : enable}>
        {enabled ? "关闭离线推送" : "开启离线推送"}
      </Button>
      {enabled && <Button onClick={test} disabled={busy}>发送测试通知</Button>}
    </Space>
    {!!detail && <Typography.Paragraph type="secondary" style={{marginTop:10,marginBottom:0}}>
      {detail}
    </Typography.Paragraph>}
  </Card>;
}
