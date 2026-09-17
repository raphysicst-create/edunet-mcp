// Infrastructure demonstration only; cannot satisfy the model release gate.
export const kind = 'smoke';
export async function next({ messages }) {
  const user = messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
  const prior = messages.at(-1);
  const finish = text => ({ text, toolCalls: [] });
  const invoke = (input, id = 'smoke-1') => ({ text: '', toolCalls: [{ id, name: 'search_edunet', arguments: input }] });
  if (prior.role === 'tool') {
    const result = prior.result?.structuredContent ?? prior.result?.structured_content;
    if (result?.pagination?.totalCount === 0 && user.includes('조건을 넓혀')) return invoke({ query: '광합성' }, 'smoke-2');
    return finish('합성 스모크 검사입니다. 검색 발췌만 확인했으며 원문과 첨부파일은 읽지 않았습니다.');
  }
  if (user === '수업자료 좀 찾아줘.') return finish('학년·과목·주제를 알려주세요.');
  if (user.includes('51페이지')) return finish('검색 한도는 50페이지입니다. 조건을 좁혀 처음부터 검색할 수 있습니다.');
  // Deterministic prompt parsing for harness checks only. No model or rubric
  // input is involved, and smoke reports remain ineligible for release.
  const input = { query: user, categories: [] };
  if (user.includes('평가자료')) input.categories.push('evl_data');
  if (user.includes('수업설계') || user.includes('수업안')) input.categories.push('lsn_design');
  if (user.includes('사진·영상')) input.categories.push('edntpd');
  if (user.includes('최신')) input.sort = 'latest';
  if (user.includes('제목')) input.searchType = 'title';
  if (user.includes('100개')) input.pageSize = 20;
  if (user.includes('같은 조건으로 다음 페이지')) Object.assign(input, { query: '광합성', categories: ['evl_data'], page: 2, pageSize: 5 });
  if (user.includes('앞 검색에서 제목 검색으로')) Object.assign(input, { query: '광합성', categories: ['evl_data'], page: 1 });
  return invoke(input);
}
