import { BinanceService } from '../binance/binance.service';
import { ExtendedService } from '../extended/extended.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { LighterService } from '../lighter/lighter.service';
import { ParadexService } from '../paradex/paradex.service';
import * as fs from 'fs/promises';
import * as path from 'path';

// Определяем интерфейс для данных ранжирования
interface Rank {
    min: number;
    max: number;
    emoji: string;
}
export interface FormattedExchangeData {
    name: string;
    leverage: number;
    accountEquity: number;
    emoji: string;
}

// Определяем интерфейс для данных с бирж
export interface ExchangeData {
    name: string;
    leverage: number;
    accountEquity: number;
}

export class SummaryService {
    private ranks: Rank[] = [];

    constructor(
        private readonly binanceService: BinanceService,
        private readonly hyperliquidService: HyperliquidService,
        private readonly paradexService: ParadexService,
        private readonly lighterService: LighterService,
        private readonly extendedService: ExtendedService
    ) {
        // Загружаем ранги при инициализации сервиса
        this.loadRanks();
    }

    private async loadRanks(): Promise<Rank[]> {
        try {
            const ranksPath = path.join(__dirname, '..', '..', '..', 'ranking-config.json');
            const data = await fs.readFile(ranksPath, 'utf-8');
            // Сразу возвращаем результат парсинга
            return JSON.parse(data);
        } catch (error) {
            console.error('Ошибка при загрузке или парсинге рангов:', error);
            // В случае ошибки возвращаем пустой массив, чтобы бот не упал.
            return [];
        }
    }

    public getEmojiForLeverage(leverage: number, ranks: Rank[]): string {
        const rank = ranks.find(r => leverage >= r.min && leverage < r.max);
        return rank ? rank.emoji : '❓';
    }

    public async getFormattedSummaryData(): Promise<FormattedExchangeData[]> {
        const ranks = await this.loadRanks();
        // Теперь Promise.allSettled будет работать с одним и тем же типом IExchangeData
        const results = await Promise.allSettled([
            this.binanceService.calculateLeverage(), // Замените на реальные методы
            this.hyperliquidService.calculateLeverage(),
            this.paradexService.calculateLeverage(),
            this.lighterService.calculateLeverage(),
            this.extendedService.calculateLeverage(),
        ]);

        const exchangeData: ExchangeData[] = [];
        const exchangeNames = ['Binance', 'HyperLiquid', 'Paradex', 'Lighter', 'Extended'];

        return results.map((result, index) => {
            const name = exchangeNames[index];

            if (result.status === 'fulfilled') {
                const { leverage, accountEquity } = result.value;
                // 4. Прямо здесь вычисляем эмодзи и добавляем его в объект.
                const emoji = this.getEmojiForLeverage(leverage, ranks);
                // Логируем результат для отладки: какая биржа и какое плечо пришло
                try {
                    //console.log(`${name} - ${leverage.toFixed(2)}`);
                } catch (e) {
                    // console.log(`${name} - ${String(leverage)}`);
                }

                return { name, leverage, accountEquity, emoji };
            } else {
                // В случае ошибки возвращаем объект-заглушку и логируем причину.
                console.error(`Ошибка при получении данных от ${name}:`, result.reason);
                try {
                    console.log(`${name} - ERROR: ${String(result.reason)}`);
                } catch (e) {
                    console.log(`${name} - ERROR`);
                }
                return { name, leverage: 0, accountEquity: 0, emoji: '❗️' };
            }
        });
    }
}

