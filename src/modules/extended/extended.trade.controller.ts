import { Context } from 'telegraf';
import { ExtendedService } from './extended.service';

// Функция задержки
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ExtendedTradeController {
    constructor(private readonly extendedService: ExtendedService) { }

    public async handleTestLimitOrder(ctx: Context): Promise<void> {
        const symbol = 'AAVE-USD';
        const side = 'BUY';
        const quantity = 0.15;

        // --- ТИП ОРДЕРА ---
        const type = 'MARKET' as 'LIMIT' | 'MARKET';
        const price = 0; // Для маркета не важно, передадим 0
        // const type = 'LIMIT' as 'LIMIT' | 'MARKET'; const price = 220;

        try {
            await ctx.reply(`🧪 <b>Extended Test</b>\nОтправляю ${type} ордер...`, { parse_mode: 'HTML' });

            // 1. Размещаем ордер
            const placementResult = await this.extendedService.placeOrder(
                symbol, side, quantity, type, price
            );

            const orderId = placementResult.orderId;

            await ctx.reply(`⏳ Ордер отправлен (ID: <code>${orderId}</code>). Жду исполнения...`, { parse_mode: 'HTML' });

            // 2. Ждем 1.5 секунды, чтобы статус обновился на сервере
            await sleep(400);
            console.log('Fetching order details for ID:', orderId);
            // 3. Запрашиваем реальные детали по ID
            const realOrderData = await this.extendedService.getOrderDetails(orderId);

            console.log('Real Order Data:', realOrderData);
            // 4. Формируем ответ
            // ВАЖНО: API вернул массив, берем первый элемент
            const order = Array.isArray(realOrderData) ? realOrderData[0] : realOrderData;

            if (!order) {
                await ctx.reply(`⚠️ Данные ордера не найдены (пустой массив).`, { parse_mode: 'HTML' });
                return;
            }

            // Маппинг полей согласно твоему логу
            const status = order.status; // FILLED
            const filledQty = order.filledQty;
            const totalQty = order.qty;
            const payedFee = order.payedFee || '0';

            // Если averagePrice не 0 (ордер исполнен), берем его. Иначе берем price.
            const rawPrice = (parseFloat(order.averagePrice) > 0) ? order.averagePrice : order.price;
            const avgPrice = parseFloat(rawPrice).toFixed(2);

            let emoji = '✅';
            if (status === 'CANCELED') emoji = '🚫';
            if (status === 'OPEN' || status === 'NEW') emoji = '⏳';

            const msg = `${emoji} <b>Ордер обработан!</b>\n\n` +
                `🆔 <b>ID:</b> <code>${order.id}</code>\n` +
                `📊 <b>Статус:</b> ${status}\n` +
                `🔹 <b>Пара:</b> ${order.market}\n` +
                `💵 <b>Цена исполнения:</b> ${avgPrice}\n` +
                `📦 <b>Заполнено:</b> ${filledQty} / ${totalQty}\n` +
                `💸 <b>Комиссия:</b> ${parseFloat(payedFee).toFixed(4)}\n\n` +
                `<i>Данные получены через GET /orders/external</i>`;

            await ctx.reply(msg, { parse_mode: 'HTML' });

        } catch (error: any) {
            console.error('Extended Test Error:', error);
            const errMsg = error.message || String(error);
            const shortError = errMsg.length > 2000 ? errMsg.substring(0, 2000) + '...' : errMsg;
            await ctx.reply(`❌ <b>Ошибка:</b>\n\n<pre>${shortError}</pre>`, { parse_mode: 'HTML' });
        }
    }
}