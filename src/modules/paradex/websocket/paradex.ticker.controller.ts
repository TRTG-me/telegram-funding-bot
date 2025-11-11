import { Context } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { ParadexTickerService } from './paradex.ticker.service';

interface ActiveTickerInfo {
    messageId: number;
    lastMessageText: string;
    lastUpdateTime: number; // --- НОВОЕ ПОЛЕ: храним время последнего обновления
}

export class ParadexTickerController {
    private activeTickers = new Map<number, ActiveTickerInfo>();

    constructor(private readonly tickerService: ParadexTickerService) { }

    public async startTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const symbol = 'BTC-USD-PERP';

        if (this.activeTickers.has(chatId)) {
            await ctx.reply('Тикер Paradex уже запущен в этом чате.');
            return;
        }

        const initialMessage = await ctx.reply(`⏳ Запускаю тикер Paradex для ${symbol}...`);

        this.activeTickers.set(chatId, {
            messageId: initialMessage.message_id,
            lastMessageText: '',
            lastUpdateTime: 0, // Инициализируем нулем
        });

        const onPriceUpdate = async (bid: string, ask: string) => {
            const tickerInfo = this.activeTickers.get(chatId);
            if (!tickerInfo) return;

            // --- РЕШЕНИЕ: Throttling (Прореживание) ---
            // 1. Проверяем, прошло ли достаточно времени с последнего обновления.
            const now = Date.now();
            const timeSinceLastUpdate = now - tickerInfo.lastUpdateTime;
            const THROTTLE_INTERVAL_MS = 500; // Интервал: 1 раз в секунду

            if (timeSinceLastUpdate < THROTTLE_INTERVAL_MS) {
                // Если прошло меньше секунды, просто игнорируем это обновление.
                return;
            }

            const escapedSymbol = symbol.replace(/([-_\[\]()~`>#\+\=\|{}\.!\\])/g, '\\$1');
            const newText = `*Paradex ${escapedSymbol}*\n\n🟢 Bid \\(покупка\\): \`${bid}\`\n🔴 Ask \\(продажа\\): \`${ask}\``;

            // Эта проверка все еще полезна, на случай если цена не менялась больше секунды.
            if (newText === tickerInfo.lastMessageText) {
                return;
            }

            tickerInfo.lastMessageText = newText;

            // 2. Обновляем время ПОСЛЕ всех проверок.
            tickerInfo.lastUpdateTime = now;

            try {
                await ctx.telegram.editMessageText(
                    chatId,
                    tickerInfo.messageId,
                    undefined,
                    newText,
                    { parse_mode: 'MarkdownV2' }
                );
            } catch (error: any) {
                if (error.description !== 'Bad Request: message is not modified') {
                    console.error('Failed to edit Paradex message:', error);
                }
            }
        };

        this.tickerService.start(symbol, onPriceUpdate);
    }

    public async stopTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const tickerInfo = this.activeTickers.get(chatId);

        if (!tickerInfo) {
            await ctx.reply('Тикер Paradex не был запущен.');
            return;
        }

        this.tickerService.stop();

        try {
            await ctx.telegram.editMessageText(
                chatId,
                tickerInfo.messageId,
                undefined,
                '✅ Тикер Paradex остановлен.'
            );
        } catch (error) {
            console.error('Failed to edit Paradex stop message:', error);
        }

        this.activeTickers.delete(chatId);
    }
}