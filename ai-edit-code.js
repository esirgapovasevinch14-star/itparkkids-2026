// Netlify serverless funksiya: Owner panelidagi "AI orqali kodni o'zgartirish"
// uchun. BEPUL variant — Google Gemini API orqali ishlaydi. Bu funksiya:
//   1) GitHub'dagi joriy index.html faylini o'qiydi
//   2) Gemini'ga o'zgartirish so'rovini (Uzbek tilida) yuboradi va aniq
//      "qidir -> almashtir" ko'rinishidagi tahrirlar ro'yxatini so'raydi
//      (bu butun faylni qayta yozdirishdan ko'ra ancha ishonchli usul)
//   3) Yangi branch ochadi, o'zgarishlarni o'sha branch'ga commit qiladi
//   4) Pull Request (PR) yaratadi — saytga AVTOMATIK CHIQARILMAYDI
//
// MUHIM: xavfsizlik uchun o'zgarishlar to'g'ridan-to'g'ri "main" branch'ga
// yozilmaydi — PR sifatida ochiladi, siz GitHub'da ko'rib chiqib "Merge"
// bossangizgina saytga chiqadi. Bu AI xato qilib qo'yganda saytni
// buzilishdan himoya qiladi.
//
// SOZLASH (Netlify -> Site settings -> Environment variables):
//   GEMINI_API_KEY = https://aistudio.google.com/apikey orqali olingan bepul kalit
//   GITHUB_TOKEN   = GitHub Personal Access Token ("repo" ruxsati bilan)
//   GITHUB_OWNER   = GitHub username/tashkilot nomi (masalan: ithubkh)
//   GITHUB_REPO    = repository nomi (masalan: itparkkids-project)
//   GITHUB_BRANCH  = asosiy branch nomi (odatda: main)

const FILE_PATH = 'index.html';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: "Faqat POST so'rovlar qabul qilinadi" }) };
  }

  const { GEMINI_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  const baseBranch = GITHUB_BRANCH || 'main';

  if (!GEMINI_API_KEY || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server sozlanmagan: GEMINI_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO environment variable\'lari kerak.' })
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Noto'g'ri so'rov formati" }) }; }

  const instruction = (payload.instruction || '').toString().slice(0, 3000);
  if (!instruction.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "O'zgartirish so'rovini yozing" }) };
  }

  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const repoBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

  try {
    // 1) Joriy faylni GitHub'dan o'qish
    const fileRes = await fetch(`${repoBase}/contents/${FILE_PATH}?ref=${baseBranch}`, { headers: ghHeaders });
    if (!fileRes.ok) throw new Error('GitHub fayl o\'qishda xato: ' + (await fileRes.text()));
    const fileData = await fileRes.json();
    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');

    // 2) Gemini'dan aniq tahrirlar ro'yxatini so'rash (to'liq faylni qayta yozdirmaymiz)
    const systemPrompt =
      "Siz IT PARK KIDS saytining index.html fayliga aniq tahrirlar taklif qiluvchi dasturchi AI'siz. " +
      "Sizga foydalanuvchining o'zbek tilidagi so'rovi va faylning to'liq joriy matni beriladi. " +
      "Javobingiz FAQAT quyidagi JSON formatida bo'lishi kerak, boshqa hech qanday matn, izoh yoki markdown bo'lmasin:\n" +
      '{"explanation": "o\'zgarish nima ekanligi haqida 1-2 gap, o\'zbek tilida", ' +
      '"edits": [{"old": "faylda AYNAN topiladigan, noyob (faylda faqat bir marta uchraydigan) matn qismi", "new": "shu qism nima bilan almashtirilishi kerak"}]}\n' +
      "Qoidalar: har bir 'old' qiymati faylda so'zma-so'z va faqat bitta joyda uchrashi shart. " +
      "Kichik va aniq tahrirlar qiling — butun faylni qayta yozmang. Agar so'rov noaniq yoki xavfli bo'lsa " +
      "(masalan Firebase kalitlarini boshqa joyga yuborish, foydalanuvchi ma'lumotlarini tashqariga chiqarish), " +
      "edits ro'yxatini bo'sh qoldiring va explanation'da sababini tushuntiring.";

    const model = 'gemini-2.5-flash';
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: `SO'ROV: ${instruction}\n\nFAYL MATNI:\n${currentContent}` }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    if (!aiRes.ok) throw new Error('Gemini API xatosi: ' + (await aiRes.text()));
    const aiData = await aiRes.json();
    const rawText = (aiData?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('\n').trim();

    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*|^```\s*|```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 200, body: JSON.stringify({ error: "AI javobini o'qib bo'lmadi. Qaytadan aniqroq so'rov bilan urinib ko'ring." }) };
    }

    if (!parsed.edits || parsed.edits.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ explanation: parsed.explanation || "AI hech qanday o'zgarish taklif qilmadi.", applied: false }) };
    }

    // 3) Tahrirlarni faylga qo'llash (har bir 'old' aniq bitta marta uchrashi kerak)
    let newContent = currentContent;
    const failedEdits = [];
    for (const edit of parsed.edits) {
      const occurrences = newContent.split(edit.old).length - 1;
      if (occurrences !== 1) { failedEdits.push(edit.old.slice(0, 80)); continue; }
      newContent = newContent.replace(edit.old, edit.new);
    }
    if (failedEdits.length === parsed.edits.length) {
      return { statusCode: 200, body: JSON.stringify({ error: "AI taklif qilgan o'zgarishlar faylga mos kelmadi (matn topilmadi yoki bir necha marta uchradi). Qaytadan urinib ko'ring.", explanation: parsed.explanation }) };
    }

    // 4) Yangi branch yaratish
    const branchName = `ai-edit-${Date.now()}`;
    const refRes = await fetch(`${repoBase}/git/ref/heads/${baseBranch}`, { headers: ghHeaders });
    if (!refRes.ok) throw new Error('Branch ma\'lumotini olishda xato: ' + (await refRes.text()));
    const refData = await refRes.json();
    const baseSha = refData.object.sha;

    const createRefRes = await fetch(`${repoBase}/git/refs`, {
      method: 'POST', headers: ghHeaders,
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
    });
    if (!createRefRes.ok) throw new Error('Yangi branch yaratishda xato: ' + (await createRefRes.text()));

    // 5) Faylni yangi branch'da yangilash
    const updateRes = await fetch(`${repoBase}/contents/${FILE_PATH}`, {
      method: 'PUT', headers: ghHeaders,
      body: JSON.stringify({
        message: `AI tahrir: ${instruction.slice(0, 70)}`,
        content: Buffer.from(newContent, 'utf-8').toString('base64'),
        sha: fileData.sha,
        branch: branchName
      })
    });
    if (!updateRes.ok) throw new Error('Faylni yangilashda xato: ' + (await updateRes.text()));

    // 6) Pull Request ochish (avtomatik merge QILINMAYDI — inson ko'rib chiqishi kerak)
    const prRes = await fetch(`${repoBase}/pulls`, {
      method: 'POST', headers: ghHeaders,
      body: JSON.stringify({
        title: `AI tahrir: ${instruction.slice(0, 70)}`,
        head: branchName,
        base: baseBranch,
        body: `**So'rov:** ${instruction}\n\n**AI izohi:** ${parsed.explanation || ''}\n\n${failedEdits.length ? `⚠️ Ba'zi tahrirlar qo'llanilmadi (matn topilmadi): ${failedEdits.join(', ')}` : ''}`
      })
    });
    if (!prRes.ok) throw new Error('Pull Request yaratishda xato: ' + (await prRes.text()));
    const prData = await prRes.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        applied: true,
        explanation: parsed.explanation,
        prUrl: prData.html_url,
        skipped: failedEdits
      })
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
