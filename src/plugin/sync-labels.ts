import type { SyncActivityFile } from "./sync-activity";
import type { SyncErrorCategory, SyncPhase, SyncRunRecord, SyncTrigger } from "./sync-diagnostics";

// 同步诊断和同步记录共用的中文对照：内部取值保持英文，界面只显示这里的中文

export const triggerLabels: Record<SyncTrigger, string> = {
  startup: "启动时同步",
  manual: "手动同步",
  edit: "编辑后同步",
  periodic: "定时检查",
  foreground: "回到前台",
  shutdown: "关闭前同步",
  resume: "恢复同步",
  online: "网络恢复后同步",
  "network-retry": "断网后重试",
  "head-retry": "远端变化后重试",
  "integrity-check": "完整校验",
};

export const phaseLabels: Record<SyncPhase, string> = {
  recovery: "恢复检查",
  remote: "读取远端",
  scanning: "扫描本地",
  hashing: "计算指纹",
  uploading: "上传",
  downloading: "下载",
  publishing: "发布",
  saving: "保存记录",
};

export const outcomeLabels: Record<SyncRunRecord["outcome"], string> = {
  running: "进行中",
  complete: "完成",
  retrying: "稍后重试",
  error: "出错",
  "action-required": "需要处理",
  interrupted: "被中断",
};

export const errorCategoryLabels: Record<SyncErrorCategory, string> = {
  network: "网络出错",
  timeout: "请求超时",
  service: "S3 服务出错",
  authentication: "凭证或权限出错",
  "remote-integrity": "远端数据异常",
  "local-change": "文件还在被修改",
  "head-race": "另一台设备先发布了",
  cancelled: "同步被取消",
  unknown: "未知错误",
};

export const fileKindLabels: Record<SyncActivityFile["kind"], string> = {
  added: "新增",
  modified: "修改",
  updated: "更新",
  deleted: "删除",
  moved: "挪动",
  restored: "恢复",
};
