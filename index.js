const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(cors());

let browser; // Глобальная переменная для браузера
let page; // Глобальная переменная для страницы

// Кеш для сохранения данных расписания
const cache = new Map();
const cacheTTL = 60 * 1000; // Время жизни кеша - 1 минута

// Функция для запуска браузера, если он еще не запущен
const launchBrowser = async () => {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    console.log('Браузер запущен.');
  }
};

// Функция для получения страницы Puppeteer, если она еще не создана
const getPage = async () => {
  if (!page) {
    await launchBrowser();
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const blockTypes = ['image', 'media', 'font', 'stylesheet'];
      if (blockTypes.includes(request.resourceType())) {
        request.abort(); // Пропускаем ресурсы, не нужные для парсинга
      } else {
        request.continue();
      }
    });

    await page.setCookie(
      { name: 'scheduleType', value: 'full', domain: 'portal.psuti.ru', path: '/' },
      { name: 'theme', value: 'light', domain: 'portal.psuti.ru', path: '/' },
      { name: 'theme_system', value: '1', domain: 'portal.psuti.ru', path: '/' }
    );
  }
  return page;
};

// Функция парсинга расписания
const parseSchedule = async (type, value, dateStart, dateEnd) => {
  await getPage();

  let url = `https://portal.psuti.ru/psuti/schedule-open/list?type=${type}&value=${encodeURIComponent(value)}`;
  if (dateStart) url += `&dateStart=${encodeURIComponent(dateStart)}`;
  if (dateEnd) url += `&dateEnd=${encodeURIComponent(dateEnd)}`;

  console.log('Переход на URL:', url);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 }); // Таймаут 10 секунд
  console.log('Страница загружена.');

  const json = await page.evaluate(() => {
    const searchText = /let\s+week\s*=\s*({[\s\S]*?});/;
    let result = null;

    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      if (searchText.test(script.textContent)) {
        const text = script.textContent;
        const jsonText = text.match(searchText);
        if (jsonText && jsonText[1]) {
          result = jsonText[1];
          break;
        }
      }
    }

    if (!result) {
      const bodyText = document.body.innerText;
      const match = bodyText.match(searchText);
      if (match && match[1]) {
        result = match[1];
      }
    }

    if (result) {
      try {
        return JSON.parse(result);
      } catch (e) {
        console.error('Ошибка при парсинге JSON:', e);
        return null;
      }
    }

    return null;
  });

  if (json) {
    console.log(`Расписание для ${type} ${value} получено.`);
    return json;
  } else {
    throw new Error('Расписание не найдено');
  }
};

// Эндпоинт для получения расписания
app.get('/api/schedule', async (req, res) => {
  const type = req.query.type;
  const value = req.query.value;
  const dateStart = req.query.dateStart || null;
  const dateEnd = req.query.dateEnd || null;

  if (!type || !value) {
    return res.status(400).json({ error: 'Не указаны тип или значение' });
  }

  const cacheKey = `${type}-${value}-${dateStart}-${dateEnd}`;

  // Проверка в кеше
  if (cache.has(cacheKey)) {
    const { json, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTTL) {
      console.log(`Отправка данных из кеша для ${type}: ${value}`);
      return res.json(json);
    }
  }

  try {
    // Парсинг и сохранение в кеш
    const json = await parseSchedule(type, value, dateStart, dateEnd);
    cache.set(cacheKey, { json, timestamp: Date.now() });
    res.json(json);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Произошла ошибка при обработке запроса' });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});
