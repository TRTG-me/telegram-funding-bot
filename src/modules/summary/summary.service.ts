import { BinanceService } from '../binance/binance.service';
import { ExtendedService } from '../extended/extended.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { LighterService } from '../lighter/lighter.service';
import { ParadexService } from '../paradex/paradex.service';
import { SettingsService } from '../settings/settings.service';

// Интерфейс данных, которые уйдут в контроллер
export interface FormattedExchangeData {
    name: string;
    leverage: number;
    accountEquity: number;
    P_MM_keff: number;
    emoji: string;
}

export class SummaryService {
    constructor(
        private readonly binanceService: BinanceService,
        private readonly hyperliquidService: HyperliquidService,
        private readonly paradexService: ParadexService,
        private readonly lighterService: LighterService,
        private readonly extendedService: ExtendedService,
        private readonly settingsService: SettingsService
    ) { }

    public getEmojiForLeverage(leverage: number): string {
        const settings = this.settingsService.getSettings();
        const { green, yellow, red } = settings.leverage;

        if (leverage >= red.value) return red.emoji;
        if (leverage >= yellow.value) return yellow.emoji;

        return green.emoji;
    }

    public async getFormattedSummaryData(userId?: number): Promise<FormattedExchangeData[]> {
        const results = await Promise.allSettled([
            this.binanceService.calculateLeverage(userId),
            this.hyperliquidService.calculateLeverage(userId),
            this.paradexService.calculateLeverage(userId),
            this.lighterService.calculateLeverage(userId),
            this.extendedService.calculateLeverage(userId),
        ]);

        const exchangeNames = ['Binance', 'HyperLiquid', 'Paradex', 'Lighter', 'Extended'];

        return results.map((result, index) => {
            const name = exchangeNames[index];

            if (result.status === 'fulfilled') {
                const { leverage, accountEquity, P_MM_keff } = result.value;

                const emoji = this.getEmojiForLeverage(leverage);

                return {
                    name,
                    leverage,
                    accountEquity,
                    P_MM_keff: P_MM_keff || 0,
                    emoji
                };
            } else {
                console.error(`Ошибка при получении данных от ${name} (User: ${userId}):`, result.reason);
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
