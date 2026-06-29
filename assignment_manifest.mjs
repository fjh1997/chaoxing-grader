export const assignments = [
  {
    key: 'assignment-1',
    title: '作业一',
    runDir: 'runs/assignment-1',
    url: 'https://mooc2-ans.chaoxing.com/mooc2-ans/work/mark?courseid=YOUR_COURSE_ID&clazzid=0&id=YOUR_WORK_ID&cpi=YOUR_CPI&evaluation=0&from=&v=0&topicid=0',
  },
];

export function selectedAssignments(keys = []) {
  const wanted = new Set(keys.filter(Boolean));
  return wanted.size
    ? assignments.filter(item => wanted.has(item.key) || wanted.has(item.title) || wanted.has(item.runDir))
    : assignments;
}
