import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000; // Usa a porta do Render ou 3000 local

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
        rejectUnauthorized: false // Necessário para TiDB Cloud
    }
});

// Testa a conexão ao iniciar
pool.getConnection()
    .then(connection => {
        console.log('✅ Conectado ao MySQL com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Erro ao conectar no MySQL:', err.message);
    });

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length > 0) return res.status(409).json({ error: 'Usuário já cadastrado.' });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        await pool.execute('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
        res.status(201).json({ message: 'Conta criada com sucesso!' });
    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({ error: 'Erro interno ao criar conta.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Email ou senha incorretos.' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos.' });

        res.json({ message: 'Login realizado!', user: { id: user.id, email: user.email } });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno ao fazer login.' });
    }
});

// --- CONFIGURAÇÕES DO ROBÔ (PUPPETEER) ---

let browser;

// --- VALUATION CONFIGS ---
const TAXA_SELIC_ATUAL = 15.0;
const SELIC_MEDIA_HISTORICA = 13.80;
const PL_BASE_GRAHAM = 8.5;
const G_CRESCIMENTO_FALLBACK = 5.0;

const GRAHAM_UNRELIABLE_SECTORS = new Set(['Tecnologia da Informação']);
const GRAHAM_UNRELIABLE_SEGMENTS = new Set(['Software e Dados']);

// --- FUNÇÃO DO BROWSER CORRIGIDA ---
async function getBrowser() {
    // Se o browser desconectou (crash), força recriação
    if (browser && !browser.isConnected()) {
        try { await browser.close(); } catch(e) {}
        browser = null;
    }

    if (!browser) {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Importante para o Render
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                // '--single-process', // REMOVIDO: Causa erro no Windows
                '--disable-gpu'
            ],
            // No Render, usa o caminho configurado (se houver). Localmente, deixa null.
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            defaultViewport: null,
        });
    }
    return browser;
}

// --- FUNÇÕES AUXILIARES ---

function strToNumber(str) {
    if (!str || typeof str !== 'string' || str.trim() === '-' || str.trim() === '') return null;
    const cleaned = str.replace(/R\$\s?/, '').replace(/\./g, '').replace(',', '.').replace('%', '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
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
        case 'dividaLiquidaEbit': return value <= 1.0 ? 'good' : (value > 3.0 ? 'bad' : 'neutral');
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

// --- FUNÇÕES DE SCRAPING ---

async function scrapeInvestidor10(browser, ticker) {
    let page;
    try {
        page = await browser.newPage();
        const url = `https://investidor10.com.br/acoes/${ticker.toLowerCase()}/`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await Promise.all([
             page.waitForSelector('#cards-ticker', { timeout: 30000 }),
             page.waitForSelector('#table-indicators', { timeout: 30000 })
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
                 const titleEl = Array.from(document.querySelectorAll('.content--info--item--title'))
                     .find(el => (el.innerText || '').trim().toLowerCase() === normalizedLabel);
                 if (titleEl) return titleEl.closest('.content--info--item')?.querySelector('.content--info--item--value')?.innerText.trim() || null;
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
                dividaLiquidaEbit: findCellText('dívida líquida / ebit'),
                cagrLucros: findCellText('cagr lucros 5 anos'),
                setor: findLinkedCellText('setor'),
                segmento: findLinkedCellText('segmento'),
                dy5Anos: findDyMedio5Anos(),
                evEbitda: findCellText('ev/ebitda'),
                pEbitda: findCellText('p/ebitda'),
                pAtivo: findCellText('p/ativo'),
                margemBruta: findCellText('margem bruta'),
                margemEbit: findCellText('margem ebit'),
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
        console.error('Erro no scraper Investidor10:', e.message);
        return {};
    } finally {
        if (page && !page.isClosed()) await page.close();
    }
}

async function scrapeXpi(browser, ticker) {
    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        const url = `https://conteudos.xpi.com.br/acoes/${ticker.toLowerCase()}/`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForSelector('.dados-produto', { timeout: 30000 });
        const data = await page.evaluate(() => {
            const getData = (label) => {
                const item = Array.from(document.querySelectorAll('.item-dado-produto')).find(i => (i.querySelector('span')?.innerText || '').trim().toLowerCase().startsWith(label.toLowerCase()));
                if (!item) return null;
                if (label === 'recomendação') return item.querySelector('.recomendacao')?.innerText.trim().toUpperCase() || null;
                if (label.startsWith('risco')) {
                    const node = Array.from(item.querySelector('.genius-risk').childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
                    return node ? node.textContent.trim() : null;
                }
                return Array.from(item.childNodes).find(n => n.nodeType === 3 && n.textContent.trim())?.textContent.trim() || null;
            };
            return { precoAlvo: getData('preço alvo'), potencial: getData('potencial'), risco: getData('risco'), recomendacao: getData('recomendação') };
        });
        return data;
    } catch (e) {
        return {};
    } finally {
         if (page && !page.isClosed()) await page.close();
    }
}

async function scrapeBtgPactual(browser, ticker) {
    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        const url = `https://content.btgpactual.com/research/ativo/${ticker.toUpperCase()}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForSelector('app-card-asset .metrics-intern', { timeout: 30000 });
        const data = await page.evaluate(() => ({
            recomendacao: document.querySelector('.buy .buy-positive-present')?.innerText.trim().toUpperCase() || document.querySelector('.buy p:not(.buy-title)')?.innerText.trim().toUpperCase() || null,
            precoAlvo: document.querySelector('.target-price-present')?.innerText.trim() || null,
            potencial: document.querySelector('.potential-present')?.innerText.trim() || null,
        }));
        return data;
    } catch(e) {
        return {};
    } finally {
         if (page && !page.isClosed()) await page.close();
    }
}

// --- ROTAS DE BUSCA ---

app.post('/buscar', async (req, res) => {
    const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker não informado' });
    try {
        const browser = await getBrowser();
        const results = await Promise.allSettled([
            scrapeInvestidor10(browser, ticker),
            scrapeXpi(browser, ticker),
            scrapeBtgPactual(browser, ticker)
        ]);
        const i10Data = results[0].status === 'fulfilled' ? results[0].value : {};
        const xpiData = results[1].status === 'fulfilled' ? results[1].value : {};
        const btgData = results[2].status === 'fulfilled' ? results[2].value : {};

        if (!i10Data || !i10Data.cotacao) {
            return res.status(404).json({ error: 'Dados essenciais não encontrados.' });
        }

        const cotacaoNum = strToNumber(i10Data.cotacao),
              vpaNum = strToNumber(i10Data.vpa),
              lpaNum = strToNumber(i10Data.lpa),
              dyNum = strToNumber(i10Data.dy),
              dy5AnosNum = strToNumber(i10Data.dy5Anos);

        const cagrLucrosNum = strToNumber(i10Data.cagrLucros);
        const g = (cagrLucrosNum !== null && cagrLucrosNum > 0) ? cagrLucrosNum : G_CRESCIMENTO_FALLBACK;
        
        const valorJustoGraham = (vpaNum && lpaNum && lpaNum > 0 && vpaNum > 0) ? Math.sqrt(22.5 * lpaNum * vpaNum) : null;
        const precoTetoBazin = (cotacaoNum && dyNum && dyNum > 0) ? (cotacaoNum * (dyNum / 100)) / 0.08 : null;
        const precoTetoBazin5Y = (cotacaoNum && dy5AnosNum && dy5AnosNum > 0) ? (cotacaoNum * (dy5AnosNum / 100)) / 0.08 : null;
        const valorRevisadoGraham = (lpaNum && lpaNum > 0 && TAXA_SELIC_ATUAL > 0 && SELIC_MEDIA_HISTORICA > 0 && g >= 0)
            ? (lpaNum * (PL_BASE_GRAHAM + 2 * g) * SELIC_MEDIA_HISTORICA) / TAXA_SELIC_ATUAL : null;

        const grahamWarning = (
            GRAHAM_UNRELIABLE_SECTORS.has(i10Data.setor) ||
            GRAHAM_UNRELIABLE_SEGMENTS.has(i10Data.segmento)
        ) ? "Fórmula de Graham pode ser ineficaz para este setor." : null;

        const createIndicatorResponse = (key, valueStr, classify = false) => {
             const classificationClass = classify ? classifyIndicator(key, valueStr) : 'neutral';
             return { value: valueStr || '-', class: classificationClass };
        };

        const responseData = {
            ticker: ticker.toUpperCase(),
            cotacao: createIndicatorResponse('cotacao', i10Data.cotacao),
            pl: createIndicatorResponse('pl', i10Data.pl, true),
            pvp: createIndicatorResponse('pvp', i10Data.pvp, true),
            dy: createIndicatorResponse('dy', i10Data.dy, true),
            dy5Anos: createIndicatorResponse('dy5AnOS', i10Data.dy5Anos, true),
            payout: createIndicatorResponse('payout', i10Data.payout, true),
            evEbitda: createIndicatorResponse('evEbitda', i10Data.evEbitda),
            pEbitda: createIndicatorResponse('pEbitda', i10Data.pEbitda),
            pAtivo: createIndicatorResponse('pAtivo', i10Data.pAtivo),
            roe: createIndicatorResponse('roe', i10Data.roe, true),
            roic: createIndicatorResponse('roic', i10Data.roic, true),
            roa: createIndicatorResponse('roa', i10Data.roa),
            margemBruta: createIndicatorResponse('margemBruta', i10Data.margemBruta),
            margemEbit: createIndicatorResponse('margemEbit', i10Data.margemEbit),
            margemEbitda: createIndicatorResponse('margemEbitda', i10Data.margemEbitda, true),
            margemLiquida: createIndicatorResponse('margemLiquida', i10Data.margemLiquida, true),
            giroAtivos: createIndicatorResponse('giroAtivos', i10Data.giroAtivos),
            dividaLiquidaEbit: createIndicatorResponse('dividaLiquidaEbit', i10Data.dividaLiquidaEbit, true),
            dividaLiquidaEbitda: createIndicatorResponse('dividaLiquidaEbitda', i10Data.dividaLiquidaEbitda, true),
            dividaLiquidaPatrimonio: createIndicatorResponse('dividaLiquidaPatrimonio', i10Data.dividaLiquidaPatrimonio),
            liquidezCorrente: createIndicatorResponse('liquidezCorrente', i10Data.liquidezCorrente, true),
            cagrLucros: createIndicatorResponse('cagrLucros', i10Data.cagrLucros, true),
            lpa: createIndicatorResponse('lpa', i10Data.lpa),
            vpa: createIndicatorResponse('vpa', i10Data.vpa),
            precoTeto: classifyValuation(i10Data.cotacao, precoTetoBazin),
            bazin5Y: classifyValuation(i10Data.cotacao, precoTetoBazin5Y),
            valorJusto: classifyValuation(i10Data.cotacao, valorJustoGraham),
            valorRevisado: classifyValuation(i10Data.cotacao, valorRevisadoGraham),
            grahamWarning: grahamWarning,
            xpiRecomendacao: { value: xpiData.recomendacao || '-', class: getRecClass(xpiData.recomendacao) },
            xpiPrecoAlvo: { value: xpiData.precoAlvo || '-', class: 'neutral'},
            xpiPotencial: { value: xpiData.potencial || '-', class: classifyIndicator('potencial', xpiData.potencial)},
            xpiRisco: { value: xpiData.risco || '-', class: 'neutral' },
            btgRecomendacao: { value: btgData.recomendacao || '-', class: getRecClass(btgData.recomendacao) },
            btgPrecoAlvo: { value: btgData.precoAlvo || '-', class: 'neutral' },
            btgPotencial: { value: btgData.potencial || '-', class: classifyIndicator('potencial', btgData.potencial) },
        };
        res.json(responseData);
    } catch (error) {
        console.error("Erro na rota /buscar:", error);
        res.status(500).json({ error: 'Erro geral ao buscar dados.' });
    }
});

app.post('/buscar-fii', async (req, res) => {
     const { ticker } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker não informado' });
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        const url = `https://investidor10.com.br/fiis/${ticker.toLowerCase()}/`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await page.waitForSelector('#cards-ticker', { timeout: 30000 });
        try { await page.waitForSelector('#indicators-history', { timeout: 15000 }); } catch (e) {}
        try { await page.waitForSelector('.basic-info', { timeout: 15000 }); } catch (e) {}
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
            const getValorDeMercado = () => {
                try {
                    const indicatorCell = Array.from(document.querySelectorAll('#table-indicators-history td.indicator'))
                                              .find(el => (el.textContent || '').trim().toUpperCase().startsWith('VALOR DE MERCADO'));
                    if (indicatorCell) {
                        const parentRow = indicatorCell.closest('tr');
                        if (parentRow) {
                            const valueCell = parentRow.querySelector('td.value');
                            if (valueCell) return valueCell.innerText.trim();
                        }
                    }
                } catch(e) { }
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
                valorMercado: getValorDeMercado(),
            };
        });
        if (page) await page.close();
        page = null;

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
            valorMercado: { value: rawData.valorMercado || '-', class: 'neutral' },
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
        if (page && !page.isClosed()) {
            try { await page.close(); } catch (closeError) { }
        }
        res.status(500).json({ error: 'Erro ao buscar dados de FII.' });
    }
});

process.on('SIGINT', async () => {
    console.log('Encerrando servidor...');
    if (browser) await browser.close();
    pool.end(); // Fecha conexão com banco
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});