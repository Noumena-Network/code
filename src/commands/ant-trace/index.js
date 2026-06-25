import { isInternalBuild } from '../../capabilities/static.js'
const antTrace = {
  type: 'local',
  name: 'ant-trace',
  description: 'Show internal tracing and trace-file diagnostics',
  argumentHint: '[status|flush|--json]',
  isEnabled: () => isInternalBuild(),
  isHidden: true,
  immediate: true,
  supportsNonInteractive: true,
  load: () => import('./ant-trace.js'),
}

export default antTrace
