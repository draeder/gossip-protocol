import { createApp } from 'vue';
import App from './App.vue';

if ('serviceWorker' in navigator) {
	window.addEventListener('load', async () => {
		try {
			await navigator.serviceWorker.register('/sw.js', { scope: '/' });
			// Keep logs quiet by default; uncomment when debugging.
			// console.log('[sw] registered');
		} catch (err) {
			// Non-fatal (some automation environments can be finicky).
			// console.warn('[sw] registration failed', err);
		}
	});
}

const app = createApp(App);
app.mount('#app');
