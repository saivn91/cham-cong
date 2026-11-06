import {zValidator} from '@hono/zod-validatior';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

// Lỗi validate trả về cùng định dạng {error, details} với app.onError.
export const jsonBody = <T extends z.ZodType>(schema: T) =>
 zValidator('json', schema, (result) => {
   if(!result.success) {
     throw new HTTPException(400, {message: 'INVALID_REQUEST', cause: result.error.issues });
   }
 });

// Chặn :id sai định dạng trước khi truy vấn DB.
export const uuidParam = (errorMessage: string) =>
 zValidator('param', z.object({ id: z.string().uuid() }), (result) => {
   if(!result.success) throw new HTTPException(400, {message: errorMessage});
 });

















