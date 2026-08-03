import { loadLLMConfig, createLLM } from '../agent/llm.js';
import { loadEnv } from '../env.js';

const ENV = loadEnv();
console.log('ENV:', ENV.KANFORGE_LLM_OPENCODE_BIN);

const config = loadLLMConfig(ENV);
console.log('config:', config);

const llm = createLLM(config);

(async () => {
    try {
        const res = await llm.complete([{ role: 'user', content: 'hello' }]);
        console.log('RES:', res);
    } catch (e) {
        console.error('LLM ERROR:', e);
    }
})();
