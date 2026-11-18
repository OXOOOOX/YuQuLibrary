// Controlled transcript, not a recording or an ASR accuracy benchmark. Gold evidence
// is labelled independently of retrieval output; times represent a synthetic one-hour episode.
export const corpusVersion = 'retrieval-controlled-v1';
export const durationMs = 3600000;
const background = [
  '清晨的街道很安静，门口的面包房刚刚开门。行人沿着河岸慢慢走，几只麻雀落在长椅旁边。我们决定先在这里休息，等太阳升起来以后再继续前往城里的旧书店。',
  '博物馆的展览分成几个房间，墙上挂着当地居民捐赠的照片。讲解员讲述了石桥修建的过程，参观者在展柜前停留片刻，随后按照指示牌走进另一间摆满陶器的大厅。',
  '这家小餐馆每天上午采购蔬菜，下午开始准备晚餐。厨房的窗户朝向院子，顾客坐在木桌旁边等待，店主为大家倒了热水，然后把刚刚烤好的面包放在桌子的中央。',
  '山脚下的学校已经放假，运动场上还有几位学生练习跑步。我们经过操场旁边的小路，看到老师正在整理花园，大家约好下周再来帮忙种花，并在校门口拍了合影。'
];
const evidence = new Map([
  [21, '家用路由器掉线后，重连采用指数退避，等待时间依次为一秒、两秒、四秒，最大三十秒。'],
  [22, '重试会加上随机抖动，避免大量设备同时请求。'],
  [100, '苹果种植完全不需要施肥。'],
  [101, '这是嘉宾一开始的说法。'],
  [377, '离线日志先写入手机本地，等网络恢复后再上传到服务端。'],
  [378, '只有收到服务端确认，才能清除这份本地日志；单纯发出请求不算保存成功。'],
  [600, '苹果种植完全不需要施肥。'],
  [601, '注意，这只是之前的错误主张，试验已推翻这个说法。'],
  [618, '内容缓存可以减少重复下载。'],
  [619, '缓存命中并不说明文件完整，还必须核对 SHA-256 摘要；核对失败就重新下载。'],
  [650, '冷备份每晚运行一次，需要暂停写入，恢复目标是前一天的数据。'],
  [651, '热备份持续运行，不要求暂停写入，恢复目标是最近五分钟的数据。'],
  [670, 'Retries use exponential backoff with jitter; a checksum verifies downloaded file integrity.'],
  [700, '灯塔修复的设备预算是八万元，交通费用另外计算；十万元是被否决的旧方案。'],
  [712, 'C# 的异步示例使用 await，而这一小节没有展示其他语言的示例。'],
  [713, 'C 语言的示例管理内存分配。'],
  [717, '刚才请嘉宾重复一下街道的名字。'],
  [718, '下个月会举办一次居民观点征集活动。']
]);
export function retrievalCorpus() {
  return Array.from({ length: 720 }, (_, index) => ({ id: `p${index}`, startMs: index * 5000, endMs: (index + 1) * 5000,
    text: evidence.get(index) ?? background[index % background.length] }));
}
export const goldQueries = [
  { name: 'early-detail', question: '路由器掉线后的指数退避最长等待多久？', required: [21, 22] },
  { name: 'cross-span', question: '路由器重连和离线日志清除分别需要什么条件？', required: [21, 377, 378] },
  { name: 'chunk-boundary-condition', question: '离线日志上传后能马上清除吗？', required: [377, 378] },
  { name: 'repeated-claim-correction', question: '苹果种植需要施肥吗？', required: [100, 101, 600, 601] },
  { name: 'negative-qualification', question: '缓存命中就能说明文件完整吗？', required: [618, 619] },
  { name: 'tail-comparison', question: '冷备份和热备份的暂停写入与恢复目标有什么区别？', required: [650, 651] },
  { name: 'english-inflection', question: 'How does a retry use backoff and verify checksums?', required: [670] },
  { name: 'rejected-number', question: '灯塔修复的设备预算是十万元吗？', required: [700] },
  { name: 'technical-name', question: 'C# 的异步示例是什么？', required: [712], excluded: [21] },
  { name: 'absent-entity', question: '火星着陆器的燃料预算是多少？', empty: true },
  { name: 'absent-language', question: 'C++ 怎么写？', empty: true },
  { name: 'generic-summary', question: '请总结一下这期节目的主要观点', empty: true }
];
