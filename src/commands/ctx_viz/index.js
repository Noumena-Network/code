import { isInternalBuild } from '../../capabilities/static.js'
const ctxViz = {
  type: 'local-jsx',
  name: 'ctx_viz',
  description: 'Internal alias for the context visualization command',
  isHidden: true,
  isEnabled: () => isInternalBuild(),
  load: () => import('../context/context.js'),
}

export default ctxViz
