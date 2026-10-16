// 项目工具在面板步骤条上的说法（单独一个文件：agent.mjs 要用，又不能反过来引用 projects.mjs）
const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

export const PROJECT_TOOL_NAMES = new Set(['project_start', 'project_list', 'project_continue', 'project_message', 'project_answer', 'project_control']);

export function describeProjectTool(name, a = {}) {
  switch (name) {
    case 'project_start':
      return `开项目：${clip(a.name, 16)}`;
    case 'project_list':
      return '看项目进度';
    case 'project_continue':
      return `接着改项目：${clip(a.project, 16)}`;
    case 'project_message':
      return `转给总指挥：${clip(a.text, 24)}`;
    case 'project_answer':
      return `回答项目的问题：${clip(a.answer, 20)}`;
    case 'project_control':
      return { approve: '项目开工', pause: '暂停项目', resume: '继续项目', stop: '停下项目', open: '打开项目页', set_dir: '换项目文件夹' }[a.action] || '管项目';
  }
  return null;
}
