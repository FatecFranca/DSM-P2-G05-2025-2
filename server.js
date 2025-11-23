import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// --- CONFIGURAÇÃO DO BANCO DE DADOS ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'admin',
    database: process.env.DB_NAME || 'investidor_app',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

// Testa conexão
pool.getConnection()
    .then(connection => {
        console.log('✅ Conectado ao MySQL com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Erro ao conectar no MySQL:', err.message);
    });

// --- ROTAS DE AUTH ---
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email/Senha obrigatórios.' });
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0) return res.status(409).json({ error: 'Usuário já existe.' });
        const hash = await bcrypt.hash(password, 10);
        await pool.execute('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
        res.status(201).json({ message: 'Conta criada!' });
    } catch (error) { res.status(500).json({ error: 'Erro no servidor.' }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Dados incorretos.' });
        const match = await bcrypt.compare(password, users[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Dados incorretos.' });
        res.json({ message: 'Logado!', user: { id: users[0].id, email: users[0].email } });
    } catch (error) { res.status(500).json({ error: 'Erro no servidor.' }); }
});

// --- PUPPETEER INTELIGENTE ---
let browser;

// Configurações Graham
const GRAHAM_UNRELIABLE_SECTORS = new Set(['Tecnologia da Informação', 'Financeiro e Outros']);
const GRAHAM_UNRELIABLE_SEGMENTS = new Set(['Software e Dados', 'Bancos']);

async function getBrowser() {
    if (browser && !browser.isConnected()) {
        try { await browser.close(); } catch(e) {}
        browser = null;
    }

    if (!browser) {
        const isRender = process.env.RENDER === 'true' || process.platform === 'linux';

        const launchConfig = {
            headless: "new",
            defaultViewport: null,
            args: []
        };

        if (isRender) {
            console.log("🚀 Modo RENDER detectado: Aplicando otimizações de memória...");
            launchConfig.args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ];
        } else {
            console.log("💻 Modo LOCAL detectado.");
        }

        browser = await puppeteer.launch(launchConfig);
    }
    return browser;
}

// --- HELPER FUNCTIONS ---
function strToNumber(str) {
    if (!str || typeof str !== 'string') return null;
    const cleaned = str.replace(/R\$\s?/, '').replace(/\./g, '').replace(',', '.').replace('%', '').trim();
    return isNaN(parseFloat(cleaned)) ? null : parseFloat(cleaned);
}

function createResponse(val, type='neutral') {
    return { value: val || '-', class: type };
}

function classifyIndicator(indicator, valueStr) {
    const value = strToNumber(valueStr);
    if (value === null) return 'neutral';
    switch (indicator) {
        case 'pvp': return value < 1.0 ? 'good' : (value > 1.5 ? 'bad' : 'neutral');
        case 'pl': return value > 0 && value < 10 ? 'good' : (value > 20 ? 'bad' : 'neutral');
        case 'dy': return value >= 6 ? 'good' : (value < 4 ? 'bad' : 'neutral');
        case 'roe': return value >= 15 ? 'good' : (value < 8 ? 'bad' : 'neutral');
        case 'roic': return value >= 10 ? 'good' : (value < 5 ? 'bad' : 'neutral');
        case 'margemLiquida': return value >= 15 ? 'good' : (value < 5 ? 'bad' : 'neutral');
        case 'margemEbitda': return value >= 20 ? 'good' : (value < 10 ? 'bad' : 'neutral');
        // Removidos lógica de Dívida Líquida/EBIT
        case 'dividaLiquidaEbitda': return value <= 2.0 ? 'good' : (value > 4.0 ? 'bad' : 'neutral');
        case 'liquidezCorrente': return value >= 1.5 ? 'good' : (value < 1.0 ? 'bad' : 'neutral');
        case 'payout': return value >= 25 && value <= 75 ? 'good' : (value > 100 ? 'bad' : 'neutral');
        case 'potencial': return value > 15 ? 'good' : (value < 0 ? 'bad' : 'neutral');
        case 'risco': return value <= 25 ? 'good' : (value > 50 ? 'bad' : 'neutral');
        case 'cagr': return value >= 10 ? 'good' : (value < 5 ? 'bad' : 'neutral');
        default: return 'neutral';
    }
}

function classifyValuation(cotacaoStr, valuation) {
    const cotacao = strToNumber(cotacaoStr);
    if (cotacao === null || valuation === null || valuation <= 0) return { value: '-', class: 'neutral' };
    const valuationStr = `R$ ${valuation.toFixed(2).replace('.', ',')}`;
    return { value: valuationStr, class: cotacao < valuation ? 'good' : 'bad' };
}

const getRecClass = (rec) => {
    if (!rec) return 'neutral';
    const lowerRec = rec.toLowerCase();
    if (lowerRec === 'compra') return 'good';
    if (lowerRec === 'venda') return 'bad';
    return 'neutral';
};

// --- SCRAPING COMPLETO (RESTAURADO) ---
async function scrapeInvestidor10(browser, ticker) {
    let page;
    try {
        page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`🔍 Buscando ${ticker}...`);
        await page.goto(`https://investidor10.com.br/acoes/${ticker.toLowerCase()}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await Promise.all([
             page.waitForSelector('#cards-ticker', { timeout: 30000 }).catch(() => {}),
             page.waitForSelector('#table-indicators', { timeout: 30000 }).catch(() => {})
        ]);

        const data = await page.evaluate(() => {
            const getTextFromTickerCard = (cardClass) => document.querySelector(`#cards-ticker ._card.${cardClass} ._card-body span`)?.innerText.trim() || null;
            
            const findCellText = (label) => {
                const normalizedLabel = label.toLowerCase().trim();
                let spans = Array.from(document.querySelectorAll('#table-indicators .cell span:first-child'));
                let found = spans.find(s => (s.innerText || '').trim().toLowerCase() === normalizedLabel);
                if (found) return found?.closest('.cell')?.querySelector('.value span')?.innerText.trim() || null;
                
                spans = Array.from(document.querySelectorAll('.cell span:first-child'));
                found = spans.find(s => (s.innerText || '').trim().toLowerCase() === normalizedLabel);
                if (found) return found?.closest('.cell')?.querySelector('.value span, .value')?.innerText.trim() || null;
                
                return null;
            };

            const findLinkedCellText = (label) => {
                const spans = Array.from(document.querySelectorAll('.cell a[href*="/setores/"] span.title'));
                const found = spans.find(s => (s.innerText || '').trim().toLowerCase() === label.toLowerCase());
                return found?.closest('a')?.querySelector('.value')?.innerText.trim() || null;
            };

            const findDyMedio5Anos = () => {
                const h3s = Array.from(document.querySelectorAll('.dy-history h3.box-span'));
                const found = h3s.find(h => (h.innerText || '').includes('DY médio em 5 anos'));
                return found?.querySelector('span')?.innerText.trim() || null;
            };

            return {
                cotacao: getTextFromTickerCard('cotacao'),
                pvp: findCellText('p/vp'),
                pl: findCellText('p/l'),
                dy: getTextFromTickerCard('dy'),
                vpa: findCellText('vpa'),
                lpa: findCellText('lpa'),
                roe: findCellText('roe'),
                margemLiquida: findCellText('margem líquida'),
                // dividaLiquidaEbit REMOVIDO
                cagrLucros: findCellText('cagr lucros 5 anos'),
                setor: findLinkedCellText('setor'),
                segmento: findLinkedCellText('segmento'),
                dy5Anos: findDyMedio5Anos(),
                // evEbitda REMOVIDO
                // pEbitda REMOVIDO
                // pAtivo REMOVIDO
                margemBruta: findCellText('margem bruta'),
                // margemEbit REMOVIDO
                margemEbitda: findCellText('margem ebitda'),
                roic: findCellText('roic'),
                dividaLiquidaEbitda: findCellText('dívida líquida / ebitda'),
                dividaLiquidaPatrimonio: findCellText('dívida líquida / patrimônio'),
                liquidezCorrente: findCellText('liquidez corrente'),
                payout: findCellText('payout'),
                giroAtivos: findCellText('giro ativos'),
                roa: findCellText('roa')
            };
        });
        return data;
    } catch(e) {
        console.error(`❌ Erro scraping ${ticker}:`, e.message);
        return {};
    } finally {
        if (page) await page.close();
    }
}

async function scrapeXpi(browser, ticker) { return {}; }
async function scrapeBtgPactual(browser, ticker) { return {}; }

// --- ROTA BUSCAR AÇÕES ---
app.post('/buscar', async (req, res) => {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker vazio' });

    console.log(`Recebida busca para: ${ticker}`);

    try {
        const browser = await getBrowser();
        const results = await Promise.allSettled([
            scrapeInvestidor10(browser, ticker)
        ]);
        
        const i10Data = results[0].status === 'fulfilled' ? results[0].value : {};

        if (!i10Data || !i10Data.cotacao || i10Data.cotacao === '-') {
            console.log("Dados não encontrados ou incompletos.");
            return res.status(404).json({ error: 'Ativo não encontrado ou erro ao ler página.' });
        }

        const cotacaoNum = strToNumber(i10Data.cotacao);
        const vpaNum = strToNumber(i10Data.vpa);
        const lpaNum = strToNumber(i10Data.lpa);
        const dyNum = strToNumber(i10Data.dy);
        const dy5AnosNum = strToNumber(i10Data.dy5Anos);
        const cagrLucrosNum = strToNumber(i10Data.cagrLucros);
        const g = (cagrLucrosNum !== null && cagrLucrosNum > 0) ? cagrLucrosNum : 5.0;
        
        const valorJustoGraham = (vpaNum && lpaNum && lpaNum > 0 && vpaNum > 0) ? Math.sqrt(22.5 * lpaNum * vpaNum) : null;
        const precoTetoBazin = (cotacaoNum && dyNum && dyNum > 0) ? (cotacaoNum * (dyNum / 100)) / 0.06 : null; 
        const precoTetoBazin5Y = (cotacaoNum && dy5AnosNum && dy5AnosNum > 0) ? (cotacaoNum * (dy5AnosNum / 100)) / 0.06 : null;
        
        const valorRevisadoGraham = (lpaNum && lpaNum > 0) ? (lpaNum * (8.5 + 2 * g) * 4.4) / 5.5 : null;

        const grahamWarning = (
            (i10Data.setor && GRAHAM_UNRELIABLE_SECTORS.has(i10Data.setor)) ||
            (i10Data.segmento && GRAHAM_UNRELIABLE_SEGMENTS.has(i10Data.segmento))
        ) ? "Graham pode ser impreciso p/ setor" : null;

        const createIndicatorResponse = (key, valueStr, classify = false) => {
             const classificationClass = classify ? classifyIndicator(key, valueStr) : 'neutral';
             return { value: valueStr || '-', class: classificationClass };
        };

        const responseData = {
            ticker: ticker.toUpperCase(),
            // Preço & Mercado
            cotacao: createIndicatorResponse('cotacao', i10Data.cotacao),
            pl: createIndicatorResponse('pl', i10Data.pl, true),
            pvp: createIndicatorResponse('pvp', i10Data.pvp, true),
            // pebitda REMOVIDO
            // evebitda REMOVIDO
            // pativo REMOVIDO
            
            // Proventos
            dy: createIndicatorResponse('dy', i10Data.dy, true),
            dy5Anos: createIndicatorResponse('dy5Anos', i10Data.dy5Anos, true),
            payout: createIndicatorResponse('payout', i10Data.payout, true),

            // Rentabilidade
            roe: createIndicatorResponse('roe', i10Data.roe, true),
            roic: createIndicatorResponse('roic', i10Data.roic, true),
            roa: createIndicatorResponse('roa', i10Data.roa),
            margemBruta: createIndicatorResponse('margemBruta', i10Data.margemBruta),
            // margemEbit REMOVIDO
            margemEbitda: createIndicatorResponse('margemEbitda', i10Data.margemEbitda, true),
            margemLiquida: createIndicatorResponse('margemLiquida', i10Data.margemLiquida, true),

            // Dívida e Liquidez
            // dividaLiquidaEbit REMOVIDO
            dividaLiquidaEbitda: createIndicatorResponse('dividaLiquidaEbitda', i10Data.dividaLiquidaEbitda, true),
            dividaLiquidaPatrimonio: createIndicatorResponse('dividaLiquidaPatrimonio', i10Data.dividaLiquidaPatrimonio),
            liquidezCorrente: createIndicatorResponse('liquidezCorrente', i10Data.liquidezCorrente, true),
            
            // Outros
            cagrLucros: createIndicatorResponse('cagrLucros', i10Data.cagrLucros, true),
            lpa: createIndicatorResponse('lpa', i10Data.lpa),
            vpa: createIndicatorResponse('vpa', i10Data.vpa),
            giroAtivos: createIndicatorResponse('giroAtivos', i10Data.giroAtivos),

            // Valuation
            precoTeto: classifyValuation(i10Data.cotacao, precoTetoBazin),
            bazin5Y: classifyValuation(i10Data.cotacao, precoTetoBazin5Y),
            valorJusto: classifyValuation(i10Data.cotacao, valorJustoGraham),
            valorRevisado: classifyValuation(i10Data.cotacao, valorRevisadoGraham),
            grahamWarning: grahamWarning,
            
            // Placeholders
            xpiRecomendacao: { value: '-', class: 'neutral' },
            xpiPrecoAlvo: { value: '-', class: 'neutral' },
            xpiPotencial: { value: '-', class: 'neutral' },
            xpiRisco: { value: '-', class: 'neutral' },
            btgRecomendacao: { value: '-', class: 'neutral' },
            btgPrecoAlvo: { value: '-', class: 'neutral' },
            btgPotencial: { value: '-', class: 'neutral' }
        };
        res.json(responseData);

    } catch (error) {
        console.error("ERRO FATAL NO SERVIDOR:", error);
        res.status(500).json({ error: 'Erro interno ao processar dados.' });
    }
});

// --- ROTA FIIs ---
app.post('/buscar-fii', async (req, res) => {
     const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker não informado' });
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(`https://investidor10.com.br/fiis/${ticker.toLowerCase()}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try { await page.waitForSelector('#cards-ticker', { timeout: 20000 }); } catch (e) {}

        const rawData = await page.evaluate(() => {
            const getTextFromTickerCard = (cardClass) => document.querySelector(`#cards-ticker ._card.${cardClass} ._card-body span`)?.innerText.trim() || null;
            const findTextByLabel = (label) => {
                const normalizedLabel = label.toLowerCase().trim();
                let allSpans = Array.from(document.querySelectorAll('.desc .name'));
                let foundSpan = allSpans.find(s => (s.innerText || '').trim().toLowerCase() === normalizedLabel);
                if (foundSpan) return foundSpan.closest('.desc')?.querySelector('.value span')?.innerText.trim() || null;
                allSpans = Array.from(document.querySelectorAll('.content--info--item--title'));
                foundSpan = allSpans.find(s => (s.innerText || '').trim().toLowerCase() === normalizedLabel);
                if (foundSpan) return foundSpan.closest('.content--info--item')?.querySelector('.content--info--item--value')?.innerText.trim() || null;
                allSpans = Array.from(document.querySelectorAll('.cell span:first-child'));
                foundSpan = allSpans.find(s => (s.innerText || '').trim().toLowerCase() === normalizedLabel);
                if (foundSpan) return foundSpan.closest('.cell')?.querySelector('.value span, .value')?.innerText.trim() || null;
                return null;
            };
            return {
                cotacao: getTextFromTickerCard('cotacao'), 
                pvp: getTextFromTickerCard('vp'), 
                dy: getTextFromTickerCard('dy'),
                liquidezDiaria: getTextFromTickerCard('val'),
                ultimoRendimento: findTextByLabel('último rendimento'), 
                y1m: findTextByLabel('yield 1 mês'),
                valorPatrimonial: findTextByLabel('valor patrimonial'),
                vpa: findTextByLabel('val. patrimonial p/ cota'),
                vacancia: findTextByLabel('vacância'),
                numCotistas: findTextByLabel('numero de cotistas'),
                cotasEmitidas: findTextByLabel('cotas emitidas'),
                segmento: findTextByLabel('segmento'),
                tipoFundo: findTextByLabel('tipo de fundo'),
                tipoGestao: findTextByLabel('tipo de gestão'),
                taxaAdm: findTextByLabel('taxa de administração'),
                // valorMercado REMOVIDO
            };
        });

        if (!rawData.cotacao || rawData.cotacao === '-') {
            return res.status(404).json({ error: 'Dados essenciais (cotação) não encontrados.' });
        }

        const cotacaoNum = strToNumber(rawData.cotacao);
        const ultimoRendimentoNum = strToNumber(rawData.ultimoRendimento);
        let ebn = '-';
        let vn = '-';
        if (cotacaoNum !== null && ultimoRendimentoNum !== null && cotacaoNum > 0 && ultimoRendimentoNum > 0) {
            const ebnNum = Math.ceil(cotacaoNum / ultimoRendimentoNum);
            ebn = String(ebnNum);
            const vnNum = ebnNum * cotacaoNum;
            vn = `R$ ${vnNum.toFixed(2).replace('.', ',')}`;
        }
        
        const pvpNum = strToNumber(rawData.pvp);
        let pvpClass = 'neutral';
        if (pvpNum !== null) {
            if (pvpNum < 1) pvpClass = 'good';
            if (pvpNum > 1.05) pvpClass = 'bad';
        }

        res.json({
            ticker: ticker.toUpperCase(),
            cotacao: { value: rawData.cotacao || '-', class: 'neutral' }, 
            pvp: { value: rawData.pvp || '-', class: pvpClass },
            dy: { value: rawData.dy || '-', class: 'neutral' }, 
            liquidezDiaria: { value: rawData.liquidezDiaria || '-', class: 'neutral' },
            // valorMercado REMOVIDO
            ultimoRendimento: { value: rawData.ultimoRendimento || '-', class: 'neutral' },
            y1m: { value: rawData.y1m || '-', class: 'neutral' }, 
            ebn: { value: String(ebn), class: 'neutral' },
            vn: { value: String(vn), class: 'neutral' },
            valorPatrimonial: { value: rawData.valorPatrimonial || '-', class: 'neutral' },
            vpa: { value: rawData.vpa || '-', class: 'neutral' },
            vacancia: { value: rawData.vacancia || '-', class: 'neutral' },
            numCotistas: { value: rawData.numCotistas || '-', class: 'neutral' },
            cotasEmitidas: { value: rawData.cotasEmitidas || '-', class: 'neutral' },
            segmento: { value: rawData.segmento || '-', class: 'neutral' },
            tipoFundo: { value: rawData.tipoFundo || '-', class: 'neutral' },
            tipoGestao: { value: rawData.tipoGestao || '-', class: 'neutral' },
            taxaAdm: { value: rawData.taxaAdm || '-', class: 'neutral' },
        });
    } catch (error) {
        if (page && !page.isClosed()) try { await page.close(); } catch (e) {}
        res.status(500).json({ error: 'Erro ao buscar dados de FII.' });
    }
});

process.on('SIGINT', async () => {
    if (browser) await browser.close();
    pool.end();
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});