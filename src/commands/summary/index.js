import { isInternalBuild } from '../../capabilities/static.js'
const summary = {
  type: 'local',
  name: 'summary',
  description: 'Refresh and show the current session summary',
  isEnabled: () => isInternalBuild(),
  isHidden: true,
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./summary.js'),
}

export default summary
