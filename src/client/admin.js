import 'ses'
import '../core/lockdown'
import { createRoot } from 'react-dom/client'

import { AdminClient } from './admin-client'

const root = createRoot(document.getElementById('root'))
root.render(<AdminClient />)
