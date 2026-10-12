import React, {useEffect, useRef, useState} from "react";
import {Button, Card, Space, Typography} from "antd";
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
    if (!userId) return undefined;
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
      setDetail("离线推送已开启，可以锁屏后接收测试通知");
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
        ? "已向推送服务提交测试通知，请检查 iPhone 通知中心"
        : "未找到可用订阅，请重新开启离线推送");
    } catch (error) {
      setDetail("测试发送失败：" + error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!userId) return null;
  return <Card size="small" title="离线推送（iPhone PWA）" className="wt-settings-card">
    <Typography.Paragraph type="secondary">
      在 iPhone 的 Safari 中「添加到主屏幕」，从主屏幕打开后点击开启。
      服务器上的 Toxcore 收到好友消息时，即使锁屏或关闭网页也可推送提醒；
      通知不会包含聊天明文。
    </Typography.Paragraph>
    <Space wrap>
      <Button type={enabled ? "default" : "primary"}
        disabled={!ready || busy}
        loading={busy}
        onClick={enabled ? disable : enable}>
        {enabled ? "关闭离线推送" : "开启离线推送"}
      </Button>
      {enabled && <Button onClick={test} disabled={busy}>发送测试通知</Button>}
      <Typography.Text type="secondary">
        {enabled ? "已订阅" : ready ? "尚未订阅" : "尚未就绪"}
      </Typography.Text>
    </Space>
    {!!detail && <Typography.Paragraph type="secondary" style={{marginTop:10,marginBottom:0}}>
      {detail}
    </Typography.Paragraph>}
    {isIPhoneOrIPad() && !isStandalone() &&
      <Typography.Paragraph type="warning">
        iPhone 必须先添加到主屏幕，并通过主屏幕图标启动，才能启用 Web Push。
      </Typography.Paragraph>}
  </Card>;
}
