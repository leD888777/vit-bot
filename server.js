import express from 'express';
import axios from 'axios';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;
const GREEN_GROUP = process.env.GREEN_GROUP_ID || '120363430474979745@g.us';
const GIGACHAT_AUTH = process.env.GIGACHAT_AUTH || 'MDFhMDg2Y2UtYWM5OS03Nzg4LThjODktNDU4NDNlYzQ1MmIzOmU0YjUzMDIwLTk0MzktNGI0NC05YTQ0LTI0MTc1MjRiMGJiOA==';

let qrData = '';
let sock = null;
const sessions = new Map();

async function getGigaToken() {
  const resp = await axios.post('https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
    'scope=GIGACHAT_API_PERS',
    {
      headers: {
        'Authorization': `Basic ${GIGACHAT_AUTH}`,
        'RqUID': crypto.randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      httpsAgent: new (await import('https')).Agent({ rejectUnauthorized: false })
    }
  );
  return resp.data.access_token;
}
function safeParse(content) {
  try { return JSON.parse(content); } catch {}
  try { return JSON.parse(content.replace(/```json|```/g,'').trim()); } catch {}
  try { const m = content.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0].replace(/'/g,'"').replace(/,\s*}/g,'}')); } catch {}
  return null;
}
async function parseWithGiga(text, history) {
  const token = await getGigaToken();
  const system = `Ты админ вет-клиники. Извлеки 9 полей: pet_type(кошка/собака), breed, name(кличка), age, weight, symptoms, address, last_visit, vaccinated. Верни ТОЛЬКО валидный JSON: {"pet_type":"","breed":"","name":"","age":"","weight":"","symptoms":"","address":"","last_visit":"","vaccinated":"","all_filled":false,"reply":"один вопрос"} all_filled=true если все 9 непустые. reply - один вопрос что спросить. История: ${history}`;
  const resp = await axios.post('https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
    { model: 'GigaChat', messages: [{ role: 'system', content: system }, { role: 'user', content: text }], temperature: 0.1 },
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, httpsAgent: new (await import('https')).Agent({ rejectUnauthorized: false }) }
  );
  let p = safeParse(resp.data.choices[0].message.content);
  if(!p) return { pet_type:'', breed:'', name:'', age:'', weight:'', symptoms:text, address:'', last_visit:'', vaccinated:'', all_filled:false, reply:'Пожалуйста, уточните породу, кличку, возраст, вес и адрес' };
  return p;
}
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000
  });
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrData = await QRCode.toDataURL(qr);
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startSock();
    } else if (connection === 'open') { console.log('WhatsApp connected'); qrData = 'connected'; }
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      if (chatId.endsWith('@g.us')) continue;
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (!text) continue;
      if (!sessions.has(chatId)) sessions.set(chatId, { history: '' });
      const sess = sessions.get(chatId);
      sess.history += `\nКлиент: ${text}`;
      try {
        const parsed = await parseWithGiga(text, sess.history);
        sess.history += `\nБот: ${parsed.reply}`;
        await sock.sendMessage(chatId, { text: parsed.reply }).catch(()=>{});
        if (parsed.all_filled && GREEN_GROUP) {
          const msg = `🚨 НОВАЯ ЗАЯВКА\nВид: ${parsed.pet_type} ${parsed.breed}\nКличка: ${parsed.name} | ${parsed.age} | ${parsed.weight}\nСимптомы: ${parsed.symptoms}\nАдрес: ${parsed.address}\nБыл у врача: ${parsed.last_visit}\nПривит: ${parsed.vaccinated}\nКлиент: ${chatId.replace('@s.whatsapp.net','')}`;
          await sock.sendMessage(GREEN_GROUP, { text: msg }).catch(()=>{});
          sessions.delete(chatId);
        }
      } catch (e) { console.error(e.message); try{ await sock.sendMessage(chatId, { text: 'Принято, уточните породу и вес' }); }catch{} }
    }
  });
}
startSock();
app.get('/', (req,res)=> res.send('vet-bot Baileys OK <a href="/qr">QR</a>'));
app.get('/healthz', (req,res)=> res.send('ok'));
app.get('/qr', (req,res)=>{
  if (!qrData) return res.send('QR not yet, refresh 5 sec');
  if (qrData==='connected') return res.send('<h2>WhatsApp подключен ✅</h2>');
  res.send(`<h2>Отсканируй QR</h2><img src="${qrData}" style="width:300px"/><script>setTimeout(()=>location.reload(),5000)</script>`);
});
app.listen(PORT, ()=> console.log(`listening ${PORT}`));
