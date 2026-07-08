// Netlify serverless funksiya: Owner panelidagi "Maxsus AI yordamchi" uchun.
// BEPUL variant — Google Gemini API orqali ishlaydi (Flash model, bepul tarif,
// karta talab qilinmaydi, muddati tugamaydi). Bu fayl serverda ishlaydi
// (brauzerda emas), shuning uchun API kalit hech qachon foydalanuvchi
// brauzerida yoki sahifa manbasida ko'rinmaydi.
//
// SOZLASH:
// 1. https://aistudio.google.com/apikey ga kiring (Google hisobingiz bilan).
// 2. "Create API key" bosing, kalitni nusxalang. Bepul, karta kerak emas.
// 3. Netlify -> Site settings -> Environment variables -> qo'shing:
//    Key: GEMINI_API_KEY   Value: <olgan kalitingiz>
// 4. Bu faylni loyihangizning "netlify/functions/ai-assist.js" yo'lida saqlang.
// 5. Qayta deploy qiling.
//
// DIQQAT: bepul tarifda kunlik so'rov chegarasi bor (odatda 1000+ so'rov/kun,
// Google vaqti-vaqti bilan o'zgartiradi). Owner panel kamdan-kam ishlatilgani
// uchun bu yetarli bo'ladi.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Faqat POST so\'rovlar qabul qilinadi' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server sozlanmagan: GEMINI_API_KEY environment variable topilmadi.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Noto\'g\'ri so\'rov formati' }) };
  }

  const userMessage = (payload.message || '').toString().slice(0, 2000);
  const context = payload.context || {};

  if (!userMessage.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Savol bo\'sh bo\'lmasligi kerak' }) };
  }

  const systemPrompt =
    "Siz 'IT PARK KIDS' bolalar loyihalari platformasi uchun Owner (sayt egasi) yordamchisisiz. " +
    "Javoblarni o'zbek tilida, qisqa va aniq bering. Quyida saytning joriy statistikasi berilgan, " +
    "javob berishda shulardan foydalaning:\n" + JSON.stringify(context);

  try {
    const model = 'gemini-2.5-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: 'Gemini API xatosi: ' + errText }) };
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';

    return { statusCode: 200, body: JSON.stringify({ reply: reply || 'Javob bo\'sh qaytdi.' }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server xatosi: ' + error.message }) };
  }
};

