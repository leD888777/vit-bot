import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GREEN_ID = process.env.GREEN_API_ID || '720122732545';
const GREEN_TOKEN = process.env.GREEN_API_TOKEN || '';
const GREEN_GROUP = process.env.GREEN_GROUP_ID || ''; // вида 1203...@g.us
const GIGACHAT_AUTH = process.env.GIGACHAT_AUTH || ''; // Base64 ClientID:ClientSecret

// память по чатам
const sessions = new Map();

async function getGigaToken() {
  if (!GIGACHAT_AUTH) throw new Error('GIGACHAT_AUTH not set');
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

async function parseWithGiga(text, history) {
  const token = await getGigaToken();
  const system = `Ты админ вет-клиники. Извлеки из диалога 9 полей: pet_type(кошка/собака), breed, name(кличка), age, weight, symptoms, address, last_visit, vaccinated. Верни ТОЛЬКО JSON вида {"pet_type":"","breed":"","name":"","age":"","weight":"","symptoms":"","address":"","last_visit":"","vaccinated":"","all_filled":true/false,"reply":"твой ответ клиенту на русском, задай только ОДИН недостающий вопрос"}. Не ставь диагноз. Если все поля есть - all_filled=true и reply="Спасибо, передал данные врачу, скоро свяжемся". История: ${history}`;
  const resp = await axios.post('https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
    {
      model: 'GigaChat',
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      temperature: 0.3
    },
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      httpsAgent: new (await import('https')).Agent({ rejectUnauthorized: false })
    }
  );
  const content = resp.data.choices[0].message.content;
  try { return JSON.parse(content); } catch { // если модель вернула с \`\`\`
    const m = content.match(/\{[\s\S]*\}/);
    return JSON.parse(m[0]);
  }
}

async function sendGreen(chatId, message) {
  const url = `https://api.green-api.com/waInstance${GREEN_ID}/sendMessage/${GREEN_TOKEN}`;
  await axios.post(url, { chatId, message });
}

app.get('/', (req, res) => res.send('vet-bot light OK'));
app.get('/healthz', (req, res) => res.send('ok'));

app.post('/webhook/whatsapp-vet', async (req, res) => {
  try {
    const body = req.body;
    // Green API формат
    const chatId = body?.senderData?.chatId || body?.senderData?.sender;
    const sender = body?.senderData?.sender;
    const text = body?.messageData?.textMessageData?.textMessage || body?.messageData?.extendedTextMessageData?.text || '';
    if (!chatId || !text) return res.sendStatus(200);
    if (chatId.endsWith('@g.us')) return res.sendStatus(200); // игнор групп

    if (!sessions.has(chatId)) sessions.set(chatId, { history: '', data: {} });
    const sess = sessions.get(chatId);
    sess.history += `\nКлиент: ${text}`;

    const parsed = await parseWithGiga(sess.history, sess.history);

    // обновляем сессию
    sess.history += `\nБот: ${parsed.reply}`;
    Object.assign(sess.data, parsed);

    // отвечаем клиенту
    await sendGreen(chatId, parsed.reply);

    // если все собрано - шлем в группу врачей
    if (parsed.all_filled && GREEN_GROUP) {
      const msg = `🚨 НОВАЯ ЗАЯВКА\nВид: ${parsed.pet_type} ${parsed.breed}\nКличка: ${parsed.name} | ${parsed.age} | ${parsed.weight}\nСимптомы: ${parsed.symptoms}\nАдрес: ${parsed.address}\nБыл у врача: ${parsed.last_visit}\nПривит: ${parsed.vaccinated}\nКлиент: ${chatId.replace('@c.us','')} ${sender||''}`;
      await sendGreen(GREEN_GROUP, msg);
      sessions.delete(chatId); // очищаем
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`vet-bot listening on ${PORT}`));
