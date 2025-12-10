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

// --- УТИЛИТЫ ---

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Округление для избежания проблем с плавающей точкой (0.1 + 0.2 != 0.3)
export const roundFloat = (num: number, decimals: number = 4) =>
    parseFloat(num.toFixed(decimals));

// --- ЛОГИКА ТИКЕРОВ ---

export async function formatSymbol(exchange: ExchangeName, coin: string): Promise<string> {
    let finalCoin = coin.toUpperCase();
    const lower = coin.toLowerCase();

    if (lower === 'kbonk' || lower === '1000bonk') {
        if (exchange === 'Binance' || exchange === 'Lighter') finalCoin = '1000BONK';
        else finalCoin = 'kBONK';
    } else if (lower === 'xyz100' || lower === 'tech100m') {
        if (exchange === 'Extended') finalCoin = 'TECH100M';
        else if (exchange === 'Hyperliquid') finalCoin = 'XYZ100';
        else finalCoin = 'TECH100m';
    }

    switch (exchange) {
        case 'Binance': return `${finalCoin}USDT`;
        case 'Hyperliquid': return finalCoin;
        case 'Paradex': return `${finalCoin}-USD-PERP`;
        case 'Extended': return `${finalCoin}-USD`;
        case 'Lighter': return finalCoin; // Сервис сам найдет ID
        default: return finalCoin;
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
        let symbol = await formatSymbol(exchange, coin);

        // ============ BINANCE ============
        if (exchange === 'Binance') {
            const res = await services.binance.placeBinOrder(symbol, side, qty);

            if (!res.clientOrderId) {
                return { success: false, error: 'No clientOrderId returned from Binance' };
            }

            let attempts = 0;
            // Ждем до 10 секунд
            while (attempts < 20) {
                try {
                    const orderInfo = await services.binance.getBinOrderInfo(symbol, res.clientOrderId);
                    if (orderInfo && orderInfo.status === 'FILLED') {
                        return { success: true, price: parseFloat(orderInfo.avgPrice) };
                    }
                } catch (e: any) {
                    if (!e.message?.includes('Order does not exist')) {
                        console.warn(`Binance retry warning: ${e.message}`);
                    }
                }
                await sleep(500);
                attempts++;
            }
            return { success: false, error: 'Binance Order Timeout' };
        }

        // ============ HYPERLIQUID ============
        else if (exchange === 'Hyperliquid') {
            if (!symbol.includes('-PERP')) symbol = symbol + '-PERP';

            // Retry logic для 502 ошибок
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

            // СТРОГИЙ РЕЖИМ: Если за 15 сек API не отдало ордер - считаем ошибкой.
            // Это остановит бота и предотвратит рассинхрон.
            return {
                success: false,
                error: `Extended API Timeout: Order ${res.orderId} unverified`
            };
        }

        // ============ LIGHTER ============
        else if (exchange === 'Lighter') {
            // placeOrder сам внутри делает Polling по txHash (до 20 сек)
            const res = await services.lighter.placeOrder(symbol, side, qty, 'MARKET');

            // СТРОГИЙ РЕЖИМ
            // Если статус ASSUMED (API 404/Timeout) или цена 0 — считаем это ошибкой.
            // Бот остановится, если вторая нога успешна.
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
            const targetSymbol = await formatSymbol('Binance', coin);
            const pos = await services.binance.getOpenPosition(targetSymbol);
            if (pos) return { size: Math.abs(parseFloat(pos.amt)), price: parseFloat(pos.entryPrice) };
        }
        else if (exchange === 'Hyperliquid') {
            const targetCoin = coin.toUpperCase().replace('-PERP', '');
            const pos = await services.hl.getOpenPosition(targetCoin);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Paradex') {
            const targetSymbol = await formatSymbol('Paradex', coin);
            const pos = await services.paradex.getOpenPosition(targetSymbol);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Extended') {
            const targetSymbol = await formatSymbol('Extended', coin);
            const pos = await services.extended.getOpenPosition(targetSymbol);
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }
        else if (exchange === 'Lighter') {
            const targetSymbol = await formatSymbol('Lighter', coin);
            const allPositions = await services.lighter.getDetailedPositions();
            const pos = allPositions.find(p => p.coin === targetSymbol || p.coin.includes(coin));
            if (pos) return { size: pos.size, price: pos.entryPrice || 0 };
        }

        return { size: 0, price: 0 };
    } catch (e: any) {
        throw new Error(`API Error [${exchange}]: ${e.message}`);
    }
}