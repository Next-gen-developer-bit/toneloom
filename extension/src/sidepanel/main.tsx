import React from 'react'
import ReactDOM from 'react-dom/client'
import SidePanelApp from './SidePanelApp'
import '../styles/global.css'

ReactDOM.createRoot(document.getElementById('sidepanel-root') as HTMLElement).render(
  <React.StrictMode>
    <SidePanelApp />
  </React.StrictMode>
)
