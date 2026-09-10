require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    FileUploadBuilder,
    LabelBuilder,
    MessageFlags,
    AttachmentBuilder,
    REST,
    Routes
} = require('discord.js');

const { ProxyAgent, setGlobalDispatcher } = require('undici');

// ============================================================
// CONFIG & PROXY SETUP
// ============================================================

const TOKEN = process.env.TOKEN;
const PROXY_URL = process.env.PROXY_URL;

if (!TOKEN) {
    throw new Error('❌ TOKEN غير موجود في ملف .env');
}

if (PROXY_URL && PROXY_URL.trim() !== '') {
    try {
        const proxyAgent = new ProxyAgent(PROXY_URL.trim());
        setGlobalDispatcher(proxyAgent);
        console.log('✅ تم تفعيل البروكسي بنجاح');
    } catch (err) {
        console.error('❌ خطأ في إعداد البروكسي:', err.message);
    }
}

const MAX_EMAILS = 500;
const CONCURRENCY_LIMIT = 1;

// ============================================================
// CLIENT & COMMAND
// ============================================================

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const checkCommand = new SlashCommandBuilder()
    .setName('فحص')
    .setDescription('فتح لوحة فحص إيميلات جوجل');

function createPanel() {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('gmail_checker_menu')
        .setPlaceholder('Checking Gmails In Google System')
        .addOptions([
            { label: 'فحص ايميلات بجوجل', description: 'فحص صحة الايميلات عبر جوجل', value: 'check_gmails', emoji: '📝' },
            { label: 'رفع ملف txt', description: 'رفع ملف يحتوي على الإيميلات للفحص', value: 'upload_txt', emoji: '📄' },
            { label: 'إعادة تعيين', description: 'اعادة تعيين القائمة', value: 'reset_menu', emoji: '🔄' }
        ]);

    return new ContainerBuilder()
        .setAccentColor(0x4285F4)
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('**** فحص إيميلات Google (البحث عن الحسابات الفعالة) ****'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('اختر الخيار المناسب من القائمة'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));
}

// ============================================================
// HELPERS
// ============================================================

function isValidEmail(email) {
    if (!email || email.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmails(input) {
    if (!input) return [];

    const lines = String(input)
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/g);

    const validEmails = [];

    for (let line of lines) {
        let cleanLine = line.trim();
        if (!cleanLine) continue;

        const emailMatch = cleanLine.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

        if (emailMatch) {
            const email = emailMatch[0].toLowerCase();
            if (isValidEmail(email)) {
                validEmails.push(email);
            }
        }
    }

    return [...new Set(validEmails)].slice(0, MAX_EMAILS);
}

// ============================================================
// GOOGLE CHECK ENGINE (التحقق من الحساب الفعال الذي يطلب كلمة مرور)
// ============================================================

async function checkGoogleAccountExists(email) {
    const normalized = email.trim().toLowerCase();

    if (!isValidEmail(normalized)) {
        return { email: normalized, exists: false, status: 'invalid_format' };
    }

    try {
        const fReqData = JSON.stringify([
            normalized, "e", [], null, null, null, null, null, null, null, null, null
        ]);

        const response = await fetch('https://accounts.google.com/_/signin/v2lookup/accountlookup?hl=en', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Google-Accounts-Xsrf': '1',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://accounts.google.com',
                'Referer': 'https://accounts.google.com/'
            },
            body: new URLSearchParams({ 'f.req': fReqData }).toString()
        });

        // إذا حدث حظر من جوجل (Too Many Requests أو Forbidden)
        if (response.status === 429 || response.status === 403) {
            return { email: normalized, exists: false, status: 'error' };
        }

        const text = await response.text();

        // 1. التحقق مما إذا كان الحساب غير موجود في جوجل
        const isNotFound = 
            text.includes("Couldn't find your Google Account") ||
            text.includes("INVALID_EMAIL") ||
            text.includes("NOT_FOUND") ||
            text.includes('["e",2]') || 
            text.includes('["e",3]');

        if (isNotFound) {
            return { email: normalized, exists: false, status: 'not_found' };
        }

        // 2. التحقق مما إذا كان الحساب فعالاً (موجود ويطلب كلمة مرور / خطوة الباسورد)
        const isFound = text.includes('["e",1]') || text.includes('INCOGNITO') || text.includes(normalized);

        if (isFound) {
            return { email: normalized, exists: true, status: 'active' };
        }

        return { email: normalized, exists: false, status: 'error' };

    } catch (error) {
        return { email: normalized, exists: false, status: 'error' };
    }
}

// ============================================================
// PROCESS EMAILS
// ============================================================

async function processEmailCheck(emailsArray) {
    const activeEmails = [];
    const notFoundEmails = [];
    const invalidEmails = [];
    const errorEmails = [];

    let index = 0;

    async function worker() {
        while (true) {
            const currentIndex = index++;
            if (currentIndex >= emailsArray.length) return;

            const email = emailsArray[currentIndex];
            const result = await checkGoogleAccountExists(email);

            if (result.status === 'active') {
                activeEmails.push(email);
            } else if (result.status === 'not_found') {
                notFoundEmails.push(email);
            } else if (result.status === 'invalid_format') {
                invalidEmails.push(email);
            } else {
                errorEmails.push(email);
            }

            // فاصل زمني 3 إلى 5 ثوانٍ لتجنب الصدمات السريعة
            const randomDelay = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
            await new Promise(r => setTimeout(r, randomDelay));
        }
    }

    const workers = Array.from(
        { length: Math.min(CONCURRENCY_LIMIT, Math.max(emailsArray.length, 1)) },
        () => worker()
    );

    await Promise.all(workers);

    const summaryMessage = [
        '📊 **نتيجة فحص إيميلات Google**',
        '',
        `📨 **إجمالي الإيميلات المفحوصة:** ${emailsArray.length}`,
        `✅ **إيميلات شغالة (تطلب كلمة مرور/موجودة):** ${activeEmails.length}`,
        `❌ **إيميلات غير موجودة في Google:** ${notFoundEmails.length}`,
        `⚠️ **صيغة غير صحيحة:** ${invalidEmails.length}`,
        `💥 **أخطاء مؤقتة (حظر من جوجل):** ${errorEmails.length}`,
        '',
        '📥 **تم إرفاق الملف المفصّل أدناه.**'
    ].join('\n');

    const fileContent = [
        '====================================',
        `✅ ACTIVE GOOGLE ACCOUNTS (${activeEmails.length})`,
        '====================================',
        activeEmails.join('\n') || 'لا يوجد',
        '',
        '====================================',
        `❌ NOT FOUND IN GOOGLE (${notFoundEmails.length})`,
        '====================================',
        notFoundEmails.join('\n') || 'لا يوجد',
        '',
        '====================================',
        `⚠️ INVALID FORMAT (${invalidEmails.length})`,
        '====================================',
        invalidEmails.join('\n') || 'لا يوجد',
        '',
        '====================================',
        `💥 ERRORS (${errorEmails.length})`,
        '====================================',
        errorEmails.join('\n') || 'لا يوجد'
    ].join('\n');

    const attachment = new AttachmentBuilder(
        Buffer.from(fileContent, 'utf8'),
        { name: 'Google_Check_Results.txt' }
    );

    return { summaryMessage, attachment };
}

// ============================================================
// MODALS & EVENTS
// ============================================================

function createEmailModal() {
    const modal = new ModalBuilder().setCustomId('gmail_text_modal').setTitle('فحص الإيميلات عبر جوجل');
    const input = new TextInputBuilder().setCustomId('emails_input').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('ضع الإيميلات أو الكومبو هنا...');
    const label = new LabelBuilder().setLabel('قائمة الإيميلات').setDescription('يدعم الإيميلات العادية أو صيغة email:password').setTextInputComponent(input);
    modal.addLabelComponents(label);
    return modal;
}

function createTxtModal() {
    const modal = new ModalBuilder().setCustomId('gmail_txt_modal').setTitle('رفع ملف TXT للإيميلات');
    const upload = new FileUploadBuilder().setCustomId('txt_file').setMinValues(1).setMaxValues(1).setRequired(true);
    const label = new LabelBuilder().setLabel('ملف الإيميلات (TXT)').setDescription('اختر ملف TXT').setFileUploadComponent(upload);
    modal.addLabelComponents(label);
    return modal;
}

async function safeError(interaction, message) {
    try {
        const payload = { content: `❌ ${message}` };
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch {}
}

client.once('clientReady', async () => {
    console.log(`✅ تم تسجيل الدخول باسم ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: [checkCommand.toJSON()] });
        console.log('✅ تم تسجيل أمر /فحص بنجاح');
    } catch (error) {
        console.error('❌ خطأ في تسجيل الأمر:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'فحص') {
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.channel.send({ components: [createPanel()], flags: MessageFlags.IsComponentsV2 });
            try { await interaction.deleteReply(); } catch {}
        } catch (error) { console.error(error); }
        return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'gmail_checker_menu') {
        const selected = interaction.values[0];
        if (selected === 'check_gmails') return interaction.showModal(createEmailModal());
        if (selected === 'upload_txt') return interaction.showModal(createTxtModal());
        if (selected === 'reset_menu') return interaction.update({ components: [createPanel()] });
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'gmail_text_modal') {
        try {
            const raw = interaction.fields.getTextInputValue('emails_input');
            const emails = normalizeEmails(raw);
            if (!emails.length) return safeError(interaction, 'لم يتم العثور على أي إيميل صالح في النص المدخل.');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const { summaryMessage, attachment } = await processEmailCheck(emails);
            await interaction.editReply({ content: summaryMessage, files: [attachment] });
        } catch (error) {
            console.error(error);
            await safeError(interaction, 'حدث خطأ أثناء فحص الإيميلات.');
        }
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'gmail_txt_modal') {
        try {
            const files = interaction.fields.getUploadedFiles('txt_file', true);
            if (!files || files.size === 0) return safeError(interaction, 'لم يتم رفع ملف.');
            const file = files.first();
            if (!file.name.toLowerCase().endsWith('.txt')) return safeError(interaction, 'يسمح بملفات TXT فقط.');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const response = await fetch(file.url);
            const text = await response.text();
            const emails = normalizeEmails(text);
            if (!emails.length) return safeError(interaction, 'الملف فارغ أو لا يحتوي على إيميلات صالحة.');
            const { summaryMessage, attachment } = await processEmailCheck(emails);
            await interaction.editReply({ content: summaryMessage, files: [attachment] });
        } catch (error) {
            console.error(error);
            await safeError(interaction, 'حدث خطأ أثناء قراءة الملف.');
        }
        return;
    }
});

client.login(TOKEN);