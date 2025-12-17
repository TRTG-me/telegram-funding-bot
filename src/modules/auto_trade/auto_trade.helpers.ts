import { ExchangeName } from './auto_trade.service';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { ExtendedService } from '../extended/extended.service';
import { LighterService } from '../lighter/lighter.service';

// Описываем интерфейс сервисов
export interface ITradingServices {
    binance: BinanceService;
    hl: HyperliquidService;
    paradex: ParadexService;
    extended: ExtendedService;
    lighter: LighterService;
}

// --- КОНФИГУРАЦИЯ МОНЕТ ---

// Тип для маппинга: null означает, что пара не торгуется на бирже
type CoinConfig = Record<string, Partial<Record<ExchangeName, string | null>>>;

const SPECIAL_COINS: CoinConfig = {
    'BONK': {
        Binance: '1000BONK', Hyperliquid: 'kBONK', Paradex: 'kBONK', Lighter: '1000BONK', Extended: '1000BONK'
    },
    'PEPE': {
        Binance: '1000PEPE', Hyperliquid: 'kPEPE', Paradex: 'kPEPE', Lighter: '1000PEPE', Extended: '1000PEPE'
    },
    'SHIB': {
        Binance: '1000SHIB', Hyperliquid: 'kSHIB', Paradex: 'kSHIB', Lighter: '1000SHIB', Extended: '1000SHIB'
    },
    'FLOKI': {
        Binance: '1000FLOKI', Hyperliquid: 'kFLOKI', Paradex: 'kFLOKI', Lighter: '1000FLOKI', Extended: null // Нет на Extended
    },
    // Технические тикеры
    'XYZ100': {
        Binance: 'XYZ100', Hyperliquid: 'XYZ100', Paradex: 'XYZ100', Lighter: 'XYZ100', Extended: 'TECH100M'
    }
};

// Алиасы для поиска (чтобы разные названия вели к одному ключу в SPECIAL_COINS)
const COIN_ALIASES: Record<string, string> = {
    'TECH100M': 'XYZ100',
    'XYZ:XYZ100': 'XYZ100', // Специфичный формат HL
    'XYZ100': 'XYZ100'
};

// --- УТИЛИТЫ ---

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const roundFloat = (num: number, decimals: number = 4) =>
    parseFloat(num.toFixed(decimals));

/**
 * НОВАЯ ФУНКЦИЯ: Получение чистого имени актива.
 * Очищает тикер от префиксов (1000, k) и суффиксов (USDT, -USD).
 * Пример:
 * 1000BONK -> BONK
 * kBONK -> BONK
 * ETH-USD-PERP -> ETH
 */
export function getAssetName(symbol: string): string {
    let s = symbol.toUpperCase();

    // 1. Убираем суффиксы бирж
    s = s.replace(/-USD-PERP$/, '')
        .replace(/-USD$/, '')
        .replace(/-PERP$/, '')
        .replace(/USDT$/, '')
        .replace(/USDC$/, '');

    // 2. Проверяем алиасы (до очистки префиксов, т.к. TECH100M специфичен)
    if (COIN_ALIASES[s]) {
        return COIN_ALIASES[s];
    }

    // 3. Убираем префиксы (1000, k, K)
    // 1000PEPE -> PEPE
    if (s.startsWith('1000')) {
        s = s.substring(4);
    }
    // KBONK -> BONK (но KDA не трогаем, проверяем длину > 3)
    if (s.startsWith('K') && s.length > 3) {
        s = s.substring(1);
    }

    // 4. Обернутые токены
    if (s === 'WETH') return 'ETH';
    if (s === 'WBTC') return 'BTC';

    return s;
}

/**
 * Универсальный метод получения тикера для конкретной биржи.
 * @param exchange Название биржи
 * @param coin Ввод пользователя (bonk, 1000bonk, kBonk, tech100m)
 * @param rawSymbolOnly Если true, вернет тикер без суффиксов (USDT, -USD), удобно для поиска ID в Lighter
 */
export function getUnifiedSymbol(exchange: ExchangeName, coin: string, rawSymbolOnly: boolean = false): string {
    const inputUpper = coin.toUpperCase();

    // 1. Получаем базовый ключ актива через новую функцию
    const baseKey = getAssetName(inputUpper);

    // 2. Определение тикера для конкретной биржи
    let targetSymbol = baseKey; // По умолчанию берем ключ (например, ETH)

    if (SPECIAL_COINS[baseKey]) {
        const specific = SPECIAL_COINS[baseKey][exchange];

        if (specific === null) {
            throw new Error(`Symbol ${baseKey} is not supported on ${exchange}`);
        }
        if (specific) {
            targetSymbol = specific;
        }
    }

    // Если нужен "сырой" тикер (для поиска ID в Lighter или HL API), возвращаем сразу
    if (rawSymbolOnly) return targetSymbol;

    // 3. Добавление суффиксов
    switch (exchange) {
        case 'Binance': return `${targetSymbol}USDT`;
        case 'Extended': return `${targetSymbol}-USD`;
        case 'Paradex': return `${targetSymbol}-USD-PERP`;
        case 'Hyperliquid': return targetSymbol; // Обычно HL не требует суффиксов (или требует -PERP для ордеров)
        case 'Lighter': return targetSymbol; // Возвращаем тикер (1000BONK), сервис сам найдет ID
        default: return targetSymbol;
    }
}

// --- ЛОГИКА ТОРГОВЛИ ---

export async function executeTrade(
    exchange: ExchangeName,
    coin: string,
    side: 'BUY' | 'SELL',
    qty: number,
    services: ITradingServices
): Promise<{ success: boolean, price?: number, error?: string }> {
    try {
        // Получаем правильный символ для биржи
        let symbol = getUnifiedSymbol(exchange, coin);

        // ============ BINANCE ============
        if (exchange === 'Binance') {
            let res: any;
            let placeAttempts = 0;
            const maxPlaceAttempts = 3;

            while (placeAttempts < maxPlaceAttempts) {
                try {
                    res = await services.binance.placeBinOrder(symbol, side, qty);
                    if (res && res.clientOrderId) break;
                } catch (e: any) {
                    console.warn(`[Binance] Place order failed (Attempt ${placeAttempts + 1}/${maxPlaceAttempts}): ${e.message}`);
                    if (placeAttempts === maxPlaceAttempts - 1) throw e;
                    if (e.message.includes('Insufficient') || e.message.includes('Invalid')) throw e;
                    await sleep(300);
                }
                placeAttempts++;
            }

            if (!res || !res.clientOrderId) {
                return { success: false, error: 'No clientOrderId returned from Binance' };
            }

            let checkAttempts = 0;
            while (checkAttempts < 20) {
                try {
                    const orderInfo = await services.binance.getBinOrderInfo(symbol, res.clientOrderId);
                    if (orderInfo && orderInfo.status === 'FILLED') {
                        return { success: true, price: parseFloat(orderInfo.avgPrice) };
                    }
                } catch (e: any) {
                    if (!e.message?.includes('Order does not exist')) {
                        console.warn(`Binance check warning: ${e.message}`);
                    }
                }
                await sleep(500);
                checkAttempts++;
            }
            return { success: false, error: 'Binance Order Timeout' };
        }
        // ============ HYPERLIQUID ============
        else if (exchange === 'Hyperliquid') {
            // HL API для ордеров требует -PERP
            if (!symbol.endsWith('-PERP')) symbol = symbol + '-PERP';

            let attempts = 0;
            while (attempts < 5) {
                try {
                    const res = await services.hl.placeMarketOrder(symbol, side, qty);
                    if (res.status === 'FILLED' || res.status === 'NEW') {
                        const avgPrice = res.avgPrice ? parseFloat(res.avgPrice) : 0;
                        return { success: true, price: avgPrice };
                    }
                    return { success: false, error: `HL Status: ${res.status}` };
                } catch (e: any) {
                    console.warn(`[Hyperliquid] Attempt ${attempts + 1} failed: ${e.message}`);
                    if (attempts === 4) return { success: false, error: `HL Error: ${e.message}` };
                    await sleep(1000);
                }
                attempts++;
            }
        }

        // ============ PARADEX ============
        else if (exchange === 'Paradex') {
            // Helper уже возвращает с -USD-PERP, но на всякий случай
            if (!symbol.endsWith('-USD-PERP')) symbol = `${symbol}-USD-PERP`;

            const res = await services.paradex.placeMarketOrder(symbol, side, qty);
            if (res.status === 'FILLED') {
                return { success: true, price: res.price };
            }
            return { success: false, error: `Paradex status: ${res.status}` };
        }

        // ============ EXTENDED ============
        else if (exchange === 'Extended') {
            const res = await services.extended.placeOrder(symbol, side, qty, 'MARKET');
            let attempts = 0;
            const maxAttempts = 15;

            while (attempts < maxAttempts) {
                await sleep(300);
                try {
                    const rawDetails = await services.extended.getOrderDetails(res.orderId);
                    const details = Array.isArray(rawDetails) ? rawDetails[0] : rawDetails;

                    if (details) {
                        const priceStr = details.averagePrice || details.avgFillPrice || details.price;
                        const realPrice = parseFloat(priceStr);
                        if (!isNaN(realPrice) && realPrice > 0) {
                            return { success: true, price: realPrice };
                        }
                    }
                } catch (e: any) { }
                attempts++;
            }

            return {
                success: false,
                error: `Extended API Timeout: Order ${res.orderId} unverified`
            };
        }

        // ============ LIGHTER ============
        else if (exchange === 'Lighter') {
            // Передаем "чистый" тикер (например 1000BONK). Сервис внутри найдет ID.
            const res = await services.lighter.placeOrder(symbol, side, qty, 'MARKET');

            if (res.status === 'ASSUMED_FILLED' || res.avgPrice <= 0) {
                return {
                    success: false,
                    error: `Lighter Unverified: ${res.status}. Tx: ${res.txHash}`
                };
            }
            console.log(res);
            return { success: true, price: res.avgPrice };
        }

        return { success: false, error: `Exchange ${exchange} not supported` };

    } catch (e: any) {
        console.error(`ExecTrade Error [${exchange}]:`, e.message);
        return { success: false, error: e.message };
    }
}

// --- ЛОГИКА ПОЗИЦИЙ ---

export async function getPositionData(
    exchange: ExchangeName,
    coin: string,
    services: ITradingServices
): Promise<{ size: number, price: number }> {
    try {
        if (exchange === 'Binance') {
            const targetSymbol = getUnifiedSymbol('Binance', coin);
            const pos = await services.binance.getOpenPosition(targetSymbol);
            if (pos) return { size: Math.abs(parseFloat(pos.amt)), price: parseFloat(pos.entryPrice) };
        }
        else if (exchange === 'Hyperliquid') {
            // HL positions API часто использует чистый тикер (kBONK), без -PERP
            const targetCoin = getUnifiedSymbol('Hyperliquid', coin, true);
            const pos = await services.hl.getOpenPosition(targetCoin);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Paradex') {
            const targetSymbol = getUnifiedSymbol('Paradex', coin);
            const pos = await services.paradex.getOpenPosition(targetSymbol);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Extended') {
            const targetSymbol = getUnifiedSymbol('Extended', coin);
            const pos = await services.extended.getOpenPosition(targetSymbol);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Lighter') {
            const targetSymbol = getUnifiedSymbol('Lighter', coin, true);
            const allPositions = await services.lighter.getDetailedPositions();
            const pos = allPositions.find(p => p.coin === targetSymbol || p.coin.includes(targetSymbol));
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }

        return { size: 0, price: 0 };
    } catch (e: any) {
        throw new Error(`API Error [${exchange}]: ${e.message}`);
    }
}