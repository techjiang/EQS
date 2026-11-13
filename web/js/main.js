import { createApp } from '/vendor/vue.esm.js'
import App from './App.js'
import { applyTheme } from './store.js'

applyTheme()
createApp(App).mount('#app')
