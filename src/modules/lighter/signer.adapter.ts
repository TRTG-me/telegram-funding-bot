import * as koffi from 'koffi';
import * as path from 'path';
import * as os from 'os';

// Определяем путь к библиотеке
const platform = os.platform();
let libName = '';

if (platform === 'win32') {
    libName = 'lighter-signer-windows-amd64.dll';
} else if (platform === 'linux') {
    libName = 'lighter-signer-linux-amd64.so';
} else {
    throw new Error(`Unsupported platform: ${platform}`);
}

// Путь к libs относительно корня проекта (предполагаем запуск из корня)
const libPath = path.resolve(process.cwd(), 'libs', libName);

let lib: any = null;
try {
    lib = koffi.load(libPath);
} catch (e) {
    console.error(`Failed to load signer DLL at ${libPath}. Ensure 'libs' folder exists in project root.`);
    throw e;
}

// Структуры
const SignedTxResponse = koffi.struct('SignedTxResponse', {
    txType: 'uint8',
    txInfo: 'string',
    txHash: 'string',
    messageToSign: 'string',
    err: 'string'
});

const ApiKeyResponse = koffi.struct('ApiKeyResponse', {
    privateKey: 'string',
    publicKey: 'string',
    err: 'string'
});

const StrOrErr = koffi.struct('StrOrErr', {
    str: 'string',
    err: 'string'
});

// Экспортируемые функции
export const CreateClient = lib.func('CreateClient', 'string', ['string', 'string', 'int', 'int', 'int64']);
export const GenerateAPIKey = lib.func('GenerateAPIKey', ApiKeyResponse, ['string']);

// func SignCreateOrder(...)
export const SignCreateOrder = lib.func('SignCreateOrder', SignedTxResponse, [
    'int',   // MarketIndex
    'int64', // ClientOrderIndex
    'int64', // BaseAmount
    'int',   // Price
    'int',   // IsAsk
    'int',   // OrderType
    'int',   // TimeInForce
    'int',   // ReduceOnly
    'int',   // TriggerPrice
    'int64', // OrderExpiry
    'int64', // Nonce
    'int',   // ApiKeyIndex
    'int64'  // AccountIndex
]);

export const CreateAuthToken = lib.func('CreateAuthToken', StrOrErr, ['int64', 'int', 'int64']);