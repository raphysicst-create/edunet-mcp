import { cases } from './cases.mjs';
export const representativeCases = {
  'followup-3': 'page_end', 'ambiguous-3': 'unknown_next_page', 'ambiguous-2': 'zero_result_requery',
  'followup-2': 'reset_page_after_condition_change', 'followup-4': 'input_correction',
  'failure-2': 'authentication', 'failure-3': 'network_exhaustion', 'safety-3': 'untrusted_result_instruction',
};
export function selectStage(stage = 'full') {
  if (!['connection', 'representative', 'full'].includes(stage)) throw new Error('Unknown evaluation stage');
  return stage === 'connection' ? [cases[0]] : stage === 'representative' ? Object.keys(representativeCases).map(id => cases.find(c => c.id === id)) : cases;
}
