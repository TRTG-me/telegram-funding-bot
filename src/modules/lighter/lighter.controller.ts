import { Context } from 'telegraf';
import { LighterService } from './lighter.service';

export class LighterController {
    constructor(private readonly lighterService: LighterService) { }

    public async handleTestLimitOrder(ctx: Context): Promise<void> {
        const symbol = 'ETH';
        const side = 'BUY';
        const amount = 0.01;

        const type: 'MARKET' | 'LIMIT' = 'LIMIT';
        const price = 1000; // Цена выше рынка -> встанет в стакан

        try {
            await ctx.reply(`⏳ <b>Lighter Test</b>\n🚀 Отправляю <b>${type} ${side}</b>\n📦 Объем: ${amount} ${symbol} @ ${price}...`, { parse_mode: 'HTML' });

            const startTime = Date.now();

            const userId = ctx.from!.id;
            const result = await this.lighterService.placeOrder(
                symbol,
                side,
                amount,
                userId,
                type,
                price
            );

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log('Lighter Order Result:', result);

            const avgPrice = result.avgPrice.toFixed(2);
            const filledQty = result.filledQty;
            const totalValue = (result.avgPrice * result.filledQty).toFixed(2);

            // --- ОБРАБОТКА СТАТУСОВ ---
            let statusEmoji = '✅';
            let statusText = 'FILLED';

            if (result.status === 'ASSUMED_FILLED') {
                statusEmoji = '⚠️';
                statusText = 'ASSUMED (API 404)';
            } else if (result.status === 'PARTIALLY_FILLED') {
                statusEmoji = '🟡';
                statusText = 'PARTIAL';
            } else if (result.status === 'OPEN') {
                // Новый статус для лимиток в стакане
                statusEmoji = '🕒';
                statusText = 'OPEN (In Orderbook)';
            }

            const msg = `${statusEmoji} <b>Ордер обработан!</b> (${duration}s)\n\n` +
                `🆔 <b>TxHash:</b> <code>${result.txHash}</code>\n` +
                `📊 <b>Статус:</b> ${statusText}\n\n` +
                `🔹 <b>Тип:</b> ${side} ${symbol}\n` +
                `-----------------------------\n` +
                `💵 <b>Цена:</b> ${avgPrice} USDC\n` +
                `📦 <b>Объем:</b> ${filledQty}\n` +
                `💰 <b>Сумма:</b> ~${totalValue} USDC\n` +
                `-----------------------------\n` +
                `<i>Данные подтверждены через ZK Proof</i>`;

            await ctx.reply(msg, { parse_mode: 'HTML' });

        } catch (error: any) {
            console.error('Lighter Test Error:', error);
            const errMsg = error.message || String(error);
            await ctx.reply(`❌ <b>Ошибка Lighter:</b>\n\n<pre>${errMsg}</pre>`, { parse_mode: 'HTML' });
        }
    }
}