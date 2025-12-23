# 🎯 ПЛАН ДЕЙСТВИЙ ПО ИСПРАВЛЕНИЮ УЯЗВИМОСТЕЙ

## 📅 ROADMAP

```
┌─────────────────────────────────────────────────────────────┐
│  ДЕНЬ 1-2: Критические исправления (C1, C2, C7)            │
│  ├─ Race Condition                                          │
│  ├─ Auto Rollback                                           │
│  └─ Double Spend Protection                                 │
├─────────────────────────────────────────────────────────────┤
│  ДЕНЬ 3-5: Стабильность (C3, C4, C5, C6)                   │
│  ├─ Memory Leak Fix                                         │
│  ├─ Telegram Queue                                          │
│  ├─ Input Validation                                        │
│  └─ WebSocket Reconnection                                  │
├─────────────────────────────────────────────────────────────┤
│  НЕДЕЛЯ 2: Высокие риски (H1-H8)                           │
│  ├─ WebSocket Timeouts                                      │
│  ├─ Lighter Verification                                    │
│  ├─ BP Validation                                           │
│  └─ Logging & Monitoring                                    │
├─────────────────────────────────────────────────────────────┤
│  НЕДЕЛЯ 3-4: Тестирование и мониторинг                     │
│  ├─ Integration Tests                                       │
│  ├─ Load Testing                                            │
│  ├─ Monitoring Setup                                        │
│  └─ Documentation                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚨 ДЕНЬ 1-2: КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ

### ✅ Задача 1: Race Condition (2 часа)
**Файлы:** `auto_trade.session.ts`

**Шаги:**
1. Открыть `src/modules/auto_trade/auto_trade.session.ts`
2. Найти строку 163 (начало блока трейда)
3. Скопировать код из `CRITICAL_FIXES.md` → Раздел "C1"
4. Заменить строки 163-174
5. Сохранить и перезапустить бота

**Тест:**
```bash
# Запустить торговлю
# Сразу нажать "OPEN POS"
# Ожидаемый результат: "🛑 Остановка запрошена. Сделка отменена."
# НЕ должно быть: "⚠️ Остановка во время сделки!"
```

**Критерий успеха:** ✅ Нет открытых позиций при быстрой остановке

---

### ✅ Задача 2: Auto Rollback (3 часа)
**Файлы:** `auto_trade.session.ts`

**Шаги:**
1. Найти строку 176 (обработка ошибок ордеров)
2. Скопировать код из `CRITICAL_FIXES.md` → Раздел "C2"
3. Заменить строки 176-185
4. Добавить логирование rollback операций

**Тест:**
```bash
# Симуляция: Отключить интернет на SHORT бирже
# Запустить торговлю
# LONG должен исполниться, SHORT упасть
# Ожидаемый результат: Автоматическое закрытие LONG
```

**Критерий успеха:** ✅ Нет односторонних позиций после ошибок

---

### ✅ Задача 3: Double Spend Protection (1 час)
**Файлы:** `auto_trade.controller.ts`

**Шаги:**
1. Добавить поле `processingUsers` в класс (после строки 31)
2. Модифицировать `handleOpenPosCommand` (строка 74)
3. Скопировать код из `CRITICAL_FIXES.md` → Раздел "C7"

**Тест:**
```bash
# Быстро нажать "OPEN POS" 10 раз подряд
# Ожидаемый результат: Только 1 сообщение "Введите тикер"
# Остальные: "⏳ Команда уже обрабатывается"
```

**Критерий успеха:** ✅ Невозможно создать дубликаты сессий

---

## ⚡ ДЕНЬ 3-5: СТАБИЛЬНОСТЬ

### ✅ Задача 4: Memory Leak Fix (2 часа)
**Файлы:** `auto_trade.controller.ts`, `bp.controller.ts`

**Шаги:**
1. Добавить `userStateTimestamps` Map
2. Добавить метод `cleanupStaleStates()`
3. Запустить cleanup каждые 60 секунд
4. Обновить все места создания/удаления states

**Тест:**
```bash
# Запустить бота
# Создать 100 "мертвых" states (начать flow и не завершить)
# Подождать 11 минут
# Проверить: node -e "console.log(process.memoryUsage())"
# Ожидаемый результат: Memory usage стабильна
```

**Критерий успеха:** ✅ Memory usage не растет со временем

---

### ✅ Задача 5: Telegram Queue (3 часа)
**Файлы:** Новый `src/common/telegram.queue.ts`, `auto_trade.controller.ts`

**Шаги:**
1. Создать файл `telegram.queue.ts`
2. Скопировать код из `CRITICAL_FIXES.md` → Раздел "C4"
3. Заменить `enqueueMessage` в контроллере
4. Удалить старый метод `processQueue`

**Тест:**
```bash
# Запустить 10 одновременных торговых сессий
# Каждая отправляет обновления каждую секунду
# Мониторить Telegram API responses
# Ожидаемый результат: Нет 429 ошибок
```

**Критерий успеха:** ✅ Нет rate limit ошибок при 10+ пользователях

---

### ✅ Задача 6: Input Validation (1 час)
**Файлы:** `auto_trade.controller.ts`

**Шаги:**
1. Найти обработку `total_qty` (строка 122)
2. Добавить проверку максимального объема
3. Настроить `MAX_SAFE_QTY` под свой депозит

**Тест:**
```bash
# Ввести totalQty = 999999
# Ожидаемый результат: "❌ Слишком большой объем!"
```

**Критерий успеха:** ✅ Невозможно ввести опасный объем

---

### ✅ Задача 7: WebSocket Reconnection (4 часа)
**Файлы:** `auto_trade.session.ts`

**Шаги:**
1. Добавить поле `waitingForPricesCount`
2. Модифицировать блок ожидания цен (строка 121)
3. Добавить логику переподключения WebSocket
4. Скопировать код из `CRITICAL_FIXES.md` → Раздел "C6"

**Тест:**
```bash
# Запустить торговлю
# Симуляция: Отключить WebSocket на бирже (firewall rule)
# Подождать 65 секунд
# Ожидаемый результат: "❌ Нет цен 60 сек. Перезапуск WebSocket..."
# Затем: "✅ WebSocket переподключен"
```

**Критерий успеха:** ✅ Автоматическое восстановление после сбоев

---

## 📊 НЕДЕЛЯ 2: ВЫСОКИЕ РИСКИ

### ✅ Задача 8: WebSocket Timeouts (2 часа)
**Файлы:** `bp.session.ts`

**Код:**
```typescript
// Добавить в класс BpSession
private lastPriceUpdate = Date.now();

// В callback WebSocket:
this.latestLongAsk = parseFloat(ask);
this.lastPriceUpdate = Date.now(); // ✅ Обновляем время

// В calculationInterval:
if (Date.now() - this.lastPriceUpdate > 30000) {
    callback(null);
    throw new Error('No price updates for 30 sec');
}
```

---

### ✅ Задача 9: Lighter Verification (3 часа)
**Файлы:** `auto_trade.helpers.ts`

**Код:**
```typescript
// В executeTrade для Lighter (строка 252)
if (exchange === 'Lighter') {
    const res = await services.lighter.placeOrder(symbol, side, qty, 'MARKET');
    
    // Если ASSUMED_FILLED, проверяем позицию
    if (res.status === 'ASSUMED_FILLED') {
        await sleep(2000);
        const position = await getPositionData('Lighter', coin, services);
        
        if (position.size >= qty * 0.95) { // 95% заполнено
            return { success: true, price: position.price };
        }
        
        return {
            success: false,
            error: `Lighter: Position not confirmed. Expected ${qty}, got ${position.size}`
        };
    }
    
    // ... остальная логика
}
```

---

### ✅ Задача 10: BP Validation (1 час)
**Файлы:** `auto_trade.session.ts`

**Код:**
```typescript
// После расчета BP (строка 135)
const currentMarketBp = ((this.currentShortBid - this.currentLongAsk) / this.currentShortBid) * 10000;

// ✅ Проверка на подозрительный BP
if (currentMarketBp > targetBp + 50) {
    await onUpdate(`⚠️ Подозрительный BP: ${currentMarketBp.toFixed(1)}. Пропуск.`);
    this.stepTimeout = setTimeout(() => this.runStep(), 1000);
    return;
}

// ✅ Проверка на отрицательный BP
if (currentMarketBp < -100) {
    await onUpdate(`⚠️ Некорректные данные (BP: ${currentMarketBp.toFixed(1)}). Пропуск.`);
    this.stepTimeout = setTimeout(() => this.runStep(), 1000);
    return;
}
```

---

### ✅ Задача 11: Session Timeout (1 час)
**Файлы:** `auto_trade.session.ts`

**Код:**
```typescript
// Добавить в класс
private sessionStartTime = Date.now();
private readonly MAX_SESSION_DURATION = 3600_000; // 1 час

// В начале runStep()
if (Date.now() - this.sessionStartTime > this.MAX_SESSION_DURATION) {
    await onUpdate('⏰ Таймаут сессии (1 час). Остановка.');
    this.stop('Session timeout');
    this.config.onFinished();
    return;
}
```

---

### ✅ Задача 12: Min Order Size Check (2 часа)
**Файлы:** `auto_trade.session.ts`, создать `exchange.limits.ts`

**Код:**
```typescript
// Создать src/common/exchange.limits.ts
export const MIN_ORDER_SIZES = {
    'Binance': { 'BTC': 0.001, 'ETH': 0.01, 'DEFAULT': 1 },
    'Hyperliquid': { 'DEFAULT': 0.1 },
    'Paradex': { 'DEFAULT': 0.1 },
    'Extended': { 'DEFAULT': 0.1 },
    'Lighter': { 'DEFAULT': 0.1 }
};

export function getMinOrderSize(exchange: string, coin: string): number {
    const limits = MIN_ORDER_SIZES[exchange];
    return limits?.[coin] || limits?.['DEFAULT'] || 0.1;
}

// В auto_trade.session.ts (перед executeTrade)
import { getMinOrderSize } from '../../common/exchange.limits';

const minLongSize = getMinOrderSize(this.config.longExchange, this.config.coin);
const minShortSize = getMinOrderSize(this.config.shortExchange, this.config.coin);
const minSize = Math.max(minLongSize, minShortSize);

if (qtyToTrade < minSize) {
    await onUpdate(`⚠️ Объем ${qtyToTrade} < минимум ${minSize}. Завершение.`);
    await this.finishTrade();
    return;
}
```

---

### ✅ Задача 13: Logging System (3 часа)
**Файлы:** Новый `src/common/logger.ts`, все сервисы

**Код:**
```typescript
// src/common/logger.ts
import winston from 'winston';
import path from 'path';

const logDir = path.join(__dirname, '../../logs');

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        // Критические ошибки
        new winston.transports.File({ 
            filename: path.join(logDir, 'critical.log'),
            level: 'error'
        }),
        // Все трейды
        new winston.transports.File({ 
            filename: path.join(logDir, 'trades.log'),
            level: 'info'
        }),
        // Console для dev
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Специальные методы
export function logTrade(data: {
    userId: number;
    coin: string;
    longExchange: string;
    shortExchange: string;
    qty: number;
    longPrice?: number;
    shortPrice?: number;
    success: boolean;
    error?: string;
}) {
    logger.info('TRADE', data);
}

export function logCritical(event: string, data: any) {
    logger.error('CRITICAL', { event, ...data, timestamp: new Date().toISOString() });
}
```

**Использование в auto_trade.session.ts:**
```typescript
import { logTrade, logCritical } from '../../common/logger';

// После успешного трейда (строка 188)
logTrade({
    userId: this.config.userId,
    coin: this.config.coin,
    longExchange: this.config.longExchange,
    shortExchange: this.config.shortExchange,
    qty: qtyToTrade,
    longPrice: longRes.price,
    shortPrice: shortRes.price,
    success: true
});

// При критической ошибке (строка 178)
logCritical('CRITICAL_LEG_FAILURE', {
    userId: this.config.userId,
    coin: this.config.coin,
    longExchange: this.config.longExchange,
    shortExchange: this.config.shortExchange,
    longResult: longRes,
    shortResult: shortRes
});
```

---

### ✅ Задача 14: BP Service Error Handling (1 час)
**Файлы:** `bp.controller.ts`

**Код:**
```typescript
// В методе startSession (строка 165)
try {
    await this.bpService.startSession(
        userId,
        state.coin,
        state.longExchange,
        state.shortExchange,
        onUpdate
    );
} catch (e: any) {
    // ✅ ПОЛНАЯ ОЧИСТКА
    this.userState.delete(userId);
    this.userStateTimestamps.delete(userId);
    this.bpService.stopSession(userId);
    
    if (state.messageId) {
        try {
            await ctx.telegram.editMessageText(
                userId, 
                state.messageId, 
                undefined, 
                `❌ Ошибка: ${e.message}`
            );
        } catch { }
    }
}
```

---

### ✅ Задача 15: Price Smoothing (2 часа)
**Файлы:** `auto_trade.session.ts`

**Код:**
```typescript
// Добавить в класс
private bpHistory: number[] = [];

// В runStep(), после расчета BP (строка 135)
const instantBp = ((this.currentShortBid - this.currentLongAsk) / this.currentShortBid) * 10000;

// Добавляем в историю
this.bpHistory.push(instantBp);
if (this.bpHistory.length > 5) {
    this.bpHistory.shift(); // Храним последние 5 значений
}

// Используем среднее значение
const currentMarketBp = this.bpHistory.reduce((a, b) => a + b, 0) / this.bpHistory.length;

// Показываем оба значения
if (onStatusUpdate) {
    await onStatusUpdate({
        filledQty: this.filledQuantity,
        totalQty: totalQuantity,
        longAsk: this.currentLongAsk,
        shortBid: this.currentShortBid,
        currentBp: currentMarketBp,
        instantBp: instantBp, // Для отладки
        status: currentMarketBp < targetBp ? 'WAITING_BP' : 'TRADING'
    });
}
```

---

## 🧪 НЕДЕЛЯ 3: ТЕСТИРОВАНИЕ

### ✅ Задача 16: Integration Tests (8 часов)

**Создать:** `tests/integration/auto_trade.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AutoTradeService } from '../../src/modules/auto_trade/auto_trade.service';

describe('AutoTrade Integration Tests', () => {
    let service: AutoTradeService;
    
    beforeEach(() => {
        service = new AutoTradeService(/* mock dependencies */);
    });
    
    afterEach(async () => {
        // Cleanup
    });
    
    it('should prevent race condition on stop', async () => {
        // Test C1 fix
    });
    
    it('should rollback on partial fill', async () => {
        // Test C2 fix
    });
    
    it('should prevent double spend', async () => {
        // Test C7 fix
    });
    
    it('should cleanup stale states', async () => {
        // Test C3 fix
    });
    
    it('should respect rate limits', async () => {
        // Test C4 fix
    });
    
    it('should validate input', async () => {
        // Test C5 fix
    });
    
    it('should reconnect websocket', async () => {
        // Test C6 fix
    });
});
```

---

### ✅ Задача 17: Load Testing (4 часа)

**Создать:** `tests/load/stress.test.ts`

```typescript
// Симуляция 50 одновременных пользователей
async function stressTest() {
    const users = Array.from({ length: 50 }, (_, i) => i + 1);
    
    await Promise.all(users.map(async (userId) => {
        // Каждый пользователь:
        // 1. Начинает flow
        // 2. Вводит данные
        // 3. Запускает торговлю
        // 4. Получает обновления
        // 5. Останавливает
    }));
    
    // Проверки:
    // - Memory usage < 500MB
    // - No rate limit errors
    // - All sessions cleaned up
}
```

---

## 📈 НЕДЕЛЯ 4: МОНИТОРИНГ

### ✅ Задача 18: Health Check Endpoint (2 часа)

**Создать:** `src/modules/health/health.controller.ts`

```typescript
export class HealthController {
    async getHealth() {
        return {
            status: 'OK',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            activeSessions: this.getActiveSessionCount(),
            websockets: await this.checkWebSockets(),
            exchanges: await this.checkExchanges()
        };
    }
    
    private async checkWebSockets() {
        // Проверка всех WebSocket соединений
    }
    
    private async checkExchanges() {
        // Ping всех бирж
    }
}
```

---

### ✅ Задача 19: Alerts System (3 часа)

**Создать:** `src/common/alerts.ts`

```typescript
import { Telegraf } from 'telegraf';

const ADMIN_CHAT_ID = process.env.ADMIN_TELEGRAM_ID;
const bot = new Telegraf(process.env.BOT_TOKEN!);

export async function sendAlert(level: 'INFO' | 'WARNING' | 'CRITICAL', message: string) {
    const emoji = {
        'INFO': 'ℹ️',
        'WARNING': '⚠️',
        'CRITICAL': '🚨'
    };
    
    await bot.telegram.sendMessage(
        ADMIN_CHAT_ID!,
        `${emoji[level]} <b>${level}</b>\n\n${message}`,
        { parse_mode: 'HTML' }
    );
}

// Использование:
// await sendAlert('CRITICAL', 'Memory usage > 80%');
// await sendAlert('WARNING', 'WebSocket reconnected 3 times');
```

---

## ✅ ЧЕКЛИСТ ГОТОВНОСТИ К ПРОДАКШЕНУ

```
КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ:
☐ C1: Race Condition
☐ C2: Auto Rollback
☐ C3: Memory Leak
☐ C4: Telegram Rate Limit
☐ C5: Input Validation
☐ C6: WebSocket Reconnection
☐ C7: Double Spend

ВЫСОКИЕ РИСКИ:
☐ H1: WebSocket Timeouts
☐ H2: Lighter Verification
☐ H3: BP Validation
☐ H4: Session Timeout
☐ H5: Price Smoothing
☐ H6: Min Order Size
☐ H7: Logging
☐ H8: BP Error Handling

ТЕСТИРОВАНИЕ:
☐ Unit Tests (80%+ coverage)
☐ Integration Tests
☐ Load Tests (50+ users)
☐ Testnet Testing (1 week)

МОНИТОРИНГ:
☐ Health Check
☐ Alerts System
☐ Logging
☐ Metrics Dashboard

ДОКУМЕНТАЦИЯ:
☐ API Documentation
☐ Deployment Guide
☐ Troubleshooting Guide
☐ User Manual
```

---

## 🎯 ФИНАЛЬНАЯ ПРОВЕРКА

Перед запуском на реальных деньгах:

1. ✅ Все чеклисты выполнены
2. ✅ Testnet работает 7+ дней без ошибок
3. ✅ Load test пройден (50+ пользователей)
4. ✅ Memory leak test пройден (24+ часа)
5. ✅ Все критические сценарии протестированы
6. ✅ Мониторинг настроен и работает
7. ✅ Есть план отката (rollback plan)
8. ✅ Команда готова к инцидентам

---

**Удачи! 🚀**
