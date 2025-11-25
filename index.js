import puppeteer from 'puppeteer';

async function buscarVPAeLPA(ticker) {
  const url = `https://investidor10.com.br/acoes/${ticker.toLowerCase()}/`;
  

  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();


  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    // Timeout e verificação de resposta
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Se a página não existir (404), o ticker provavelmente está errado
    if (response.status() === 404) {
        throw new Error(`Ticker '${ticker}' não encontrado.`);
    }

    const dados = await page.evaluate(() => {

      
      const getIndicatorValue = (indicatorName) => {
        // Procura todos os cards de indicadores
        const elements = Array.from(document.querySelectorAll('.cell .name'));
        const targetEl = elements.find(el => el.innerText.includes(indicatorName));
        
        if (targetEl) {
          const parent = targetEl.closest('.cell');
          const valueEl = parent ? parent.querySelector('.value span') : null;
          return valueEl ? valueEl.innerText.trim() : null;
        }
        return null;
      };

      return {
        vpa: getIndicatorValue('VPA'),
        lpa: getIndicatorValue('LPA')
      };
    });

    const parseBRL = (str) => str ? parseFloat(str.replace('.', '').replace(',', '.')) : 0;

    if (dados.vpa && dados.lpa) {
      const vpaNum = parseBRL(dados.vpa);
      const lpaNum = parseBRL(dados.lpa);
      
      console.log(`--- Relatório para ${ticker.toUpperCase()} ---`);
      console.log(`VPA: R$ ${dados.vpa} (Numérico: ${vpaNum})`);
      console.log(`LPA: R$ ${dados.lpa} (Numérico: ${lpaNum})`);
   
      if(vpaNum > 0 && lpaNum > 0) {
          const vi = Math.sqrt(22.5 * lpaNum * vpaNum);
          console.log(`Valor Intrínseco (Graham): R$ ${vi.toFixed(2)}`);
      }
      
    } else {
      console.log('Dados incompletos ou layout do site alterado.');
    }

  } catch (err) {
    console.error(`Erro: ${err.message}`);
  } finally {
    await browser.close();
  }
}

const ticker = process.argv[2] || 'PETR4';
buscarVPAeLPA(ticker);
