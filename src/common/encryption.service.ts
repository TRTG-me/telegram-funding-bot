import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = process.env.ENCRYPTION_KEY || ''; // 32 chars check below
const IV_LENGTH = 16; // AES block size

if (SECRET_KEY.length !== 32) {
    // В dev среде можно просто кинуть варнинг или сгенерировать временный, 
    // но для прода лучше упасть, если ключа нет.
    console.warn(`⚠️ WARNING: ENCRYPTION_KEY is not 32 chars (current: ${SECRET_KEY.length}). Encryption will fail.`);
}

export class EncryptionService {

    // Зашифровать
    static encrypt(text: string): string {
        if (!text) return text;
        try {
            const iv = crypto.randomBytes(IV_LENGTH);
            const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(SECRET_KEY), iv);
            let encrypted = cipher.update(text);
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            // Format: iv:encryptedData
            return iv.toString('hex') + ':' + encrypted.toString('hex');
        } catch (e: any) {
            console.error('Encryption failed:', e.message);
            throw new Error('Encryption failed');
        }
    }

    // Расшифровать
    static decrypt(text: string): string {
        if (!text || !text.includes(':')) return text;
        try {
            const textParts = text.split(':');
            const iv = Buffer.from(textParts.shift()!, 'hex');
            const encryptedText = Buffer.from(textParts.join(':'), 'hex');
            const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(SECRET_KEY), iv);
            let decrypted = decipher.update(encryptedText);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            return decrypted.toString();
        } catch (e) {
            console.error('Decryption failed (bad key or corrupted data)');
            return '';
        }
    }
}
