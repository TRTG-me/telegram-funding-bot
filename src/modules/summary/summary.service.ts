import { BinanceService } from '../binance/binance.service';
import { ExtendedService } from '../extended/extended.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { LighterService } from '../lighter/lighter.service';
import { ParadexService } from '../paradex/paradex.service';
import * as fs from 'fs/promises';
import * as path from 'path';

interface Rank {
    min: number;
    max: number;
    emoji: string;
}

// Интерфейс данных, которые уйдут в контроллер
export interface FormattedExchangeData {
    name: string;
    leverage: number;
    accountEquity: number;
    P_MM_keff: number; // <--- Добавили поле
    emoji: string;
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
        this.loadRanks();
    }

    private async loadRanks(): Promise<Rank[]> {
        try {
            const ranksPath = path.join(__dirname, '..', '..', '..', 'ranking-config.json');
            const data = await fs.readFile(ranksPath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Ошибка при загрузке рангов:', error);
            return [];
        }
    }

    public getEmojiForLeverage(leverage: number, ranks: Rank[]): string {
        const rank = ranks.find(r => leverage >= r.min && leverage < r.max);
        return rank ? rank.emoji : '❓';
    }

    public async getFormattedSummaryData(): Promise<FormattedExchangeData[]> {
        const ranks = await this.loadRanks();

        const results = await Promise.allSettled([
            this.binanceService.calculateLeverage(),
            this.hyperliquidService.calculateLeverage(),
            this.paradexService.calculateLeverage(),
            this.lighterService.calculateLeverage(),
            this.extendedService.calculateLeverage(),
        ]);

        const exchangeNames = ['Binance', 'HyperLiquid', 'Paradex', 'Lighter', 'Extended'];

        return results.map((result, index) => {
            const name = exchangeNames[index];

            if (result.status === 'fulfilled') {
                // Извлекаем все поля, включая новый коэффициент
                // (Typescript должен знать об этом поле через IExchangeData в common/interfaces)
                const { leverage, accountEquity, P_MM_keff } = result.value;

                const emoji = this.getEmojiForLeverage(leverage, ranks);

                return {
                    name,
                    leverage,
                    accountEquity,
                    P_MM_keff: P_MM_keff || 0, // Защита от undefined
                    emoji
                };
            } else {
                console.error(`Ошибка при получении данных от ${name}:`, result.reason);
                return {
                    name,
                    leverage: 0,
                    accountEquity: 0,
                    P_MM_keff: 0, // Заглушка при ошибке
                    emoji: '❗️'
                };
            }
        });
    }
}