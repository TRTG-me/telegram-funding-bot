import { Context } from 'telegraf';
import { Update } from 'telegraf/typings/core/types/typegram';
import { BinanceTickerService } from './binance.ticker.service';

interface ActiveTickerInfo {
    messageId: number;
    lastMessageText: string;
    lastUpdateTime: number; // --- НОВОЕ ПОЛЕ: храним время последнего обновления
}

export class BinanceTickerController {
    private activeTickers = new Map<number, ActiveTickerInfo>();

    constructor(private readonly tickerService: BinanceTickerService) { }

    public async startTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const symbol = 'DYMUSDT';

        if (this.activeTickers.has(chatId)) {
            await ctx.reply('Тикер Binance уже запущен в этом чате.');
            return;
        }

        const initialMessage = await ctx.reply(`⏳ Запускаю тикер для ${symbol}...`);

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
            const THROTTLE_INTERVAL_MS = 500; // Интервал: 500 миллисекунд

            if (timeSinceLastUpdate < THROTTLE_INTERVAL_MS) {
                // Если прошло меньше 500 мс, просто игнорируем это обновление.
                return;
            }

            const newText = `*${symbol}*\n\n🟢 Bid \\(покупка\\): \`${bid}\`\n🔴 Ask \\(продажа\\): \`${ask}\``;

            if (newText === tickerInfo.lastMessageText) {
                return;
            }

            // Оптимистичное обновление состояния перед отправкой
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
                    console.error('Failed to edit Binance message:', error);
                }
            }
        };

        await this.tickerService.start(symbol, onPriceUpdate);
    }

    public async stopTicker(ctx: Context<Update.MessageUpdate>): Promise<void> {
        const chatId = ctx.chat.id;
        const tickerInfo = this.activeTickers.get(chatId);

        if (!tickerInfo) {
            await ctx.reply('Тикер Binance не был запущен.');
            return;
        }

        await this.tickerService.stop();

        try {
            await ctx.telegram.editMessageText(
                chatId,
                tickerInfo.messageId,
                undefined,
                '✅ Тикер Binance остановлен.'
            );
        } catch (error) {
            console.error('Failed to edit Binance stop message:', error);
        }

        this.activeTickers.delete(chatId);
    }
}