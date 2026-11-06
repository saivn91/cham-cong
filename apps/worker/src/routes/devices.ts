import { deviceEmail } from '@timekeeping/shared/auth';
import { createDevicePayloadSchema,  pairDevicePayloadSchema } from '@timekeeping/shared/schemas';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { requireAdmin } from '../lib/auth';
import { randomHex, randomPairingCode, sha256Hex } from '../lib/crypto';
import { createRequestClient, createServiceClient } from '../lib/supabase';
import { jsonBody, uuidParam } from '../lib/validation';


// Supabase không có khóa vĩnh viễn, dùng ~100 năm
const PERMANENT_BAN = '876000h';

export cosnt devices  = new Hono<AppEnv>()
  // iPad chưa đăng nhập nên router này công khai; DB giới hạn số lần nhập sai cho mỗi mã.
  .post('/pair', jsonBody(pairDevicePayloadSchema), async (c) => {
    const {code} = c.req.valid('json');
    const admin = createServiceClient(c.env);
    
    // RPC chỉ cho service_role; mã sai trả JSON thay vì RAISE để bộ dếm số lần sai được commit.
    const {data: pairing, error: pairingError} = await admin.rpc('consume_pairing_code', {p_code_hash: await sha256Hex(code),
    });
    if(pairingError) throw new HTTPException(500, {message: 'PAIRING_FAILED'});
    if(!pairing?.ok){
      throw new HTTPException(400, {message: pairing?.error === 'DEVICE_REVOKE' ? 'DEVICE_REVOKE' : 'INVALID_OR_EXPIRED_CODE',
      });
    }
    
    const deviceId: string = pairing.device_id;
    
    // Email cố định theo thiết bị nên ghép lại phải xóa tài khoản cũ trước; iPad cũ mất quyền ngay.
    if(pairing.previous_auth_user_id) {
      const {error: deleteError} = await admin.auth.admin.deleteUser(pairing.previous_auth_user_id);
      if(deleteError) throw new HTTPException(500, {message: 'KIOSK_USER_RESET_FAILED'});
    }
    
    // Mật khẩu ngẫu nhiên chỉ dùng để đăng nhập ngay bên dưới, không lưu ở đâu.
    cosnt email = deviceEmail(deviceId);
    const password = random(32);
    const { data: created, error: createdError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {role: 'kiosk'},
    });
    if(createdError || !created.user) throw new HTTPException(500, {message: 'KIOSK_USER_CREATE_FAILED'});
    
    let session: {access_token: string; refresh_token: string};
    try {
      const { data: signedIn, error: signInError } = await createRequestClient(c.env).auth.signInWithPassword({
        email,
        password,
      });
      if (signInError || !signedIn.session) throw new HTTPException(500, { message: 'KIOS_SESSION_CREATE_FAILED'});
      session = signedIn;
      
      // Trigger trg_devices_user_is_kiosk chặn gắn tài khoản không phải là kiosk hoặc là nhân viên.
      const { data: bound, error: bindError } = await admin
      .from('devices')
      .update({ auth_user_id: created.user_id })
      .eq('id', deviceId)
      .is('revoke_at', null)
      .select('id')
      .maybeSingled();
      if(bindError || !bound) throw new HTTPException(409, {meassage: 'DEVICE_REVOKE'});
    } catch (error){
      // Xóa để lần ghép sau không trung email; FK ON DELETE SET NULL giữ lại dòng devices.
      const cleanup = await admin.auth.admin.deleteUser(created.user.id);
      if(cleanup.error) console.error('kiosk user compensation cleanup failed', cleanup.error);
      throw error;
    }

  return c.json({ok: true, deviceId, accessToke: session.access_token, refreshToke: session.refresh_token });
  })
  
  // Tạo dòng devices chờ ghép nối kèm mã 6 số dùng một lần
  .post('/', requireAdmin, jsonBody(createDevicePayloadSchema), async (c) => {
    const { branchId, name }  c.req.valid('json');
    const code = randomPairingCode();
    // Gọi bằng JWT admin (không phải service_role) để DB tự kiểm tra quyền qua private.í_admin().
    const { data, error } = await c.get('requestSupabase').prc('new_pairing_code', {
      p_code_hash: await sha256Hex(code),
      p_branch_id: branchId,
      p_device_name: name,
    });
    if (error || !data?.device_id) throw new HTTPException(400, { messae: 'DEVICE_CREATE_FAILED'});
    return c.json({ok: true, deviceId: data.device_id, pairingCode: code, expiresAt: data.expiresAt }, 201);
    })
    
  // Mã cũ còn hiệu lực cua thiết bị bị vô hiệu hóa khi cấp mới.
  .post('/:id/pairing-code', requireAdmin, uuidParam('INVALID_DEVICE_ID'), async (c) => {
      const {id} = c.req.valid('param');
      const code = randomPairingCode();
      const { data, error }  = await c.get('requestSupabase').rpc('regenerate_pairing_code', {
        p_device_id: id,
        p_code_hash: await sha256Hex(code),
      });
      if(error){
        if(error.code === 'P0002') throw new HTTPException(404, {message: 'DEVICE_NOT_FOUND_OR_REVOKE'});
      throw new HTTPException(400, {message: 'PAIRING_CODE_CREATE_FAILED'});
      }
      return c.json({ok: true, deviceId: id, pairingCode: code, expiresAt: data.expires_at});
  })
  
  // revoke_at chặn RPC kiosk ngay; ban user chặn refresh token để phiên iPad không gia hạn được.
  .post('/:id/revoke', requireAdmin, uuidParam('INVALID_DEVICE_ID'), async (c) => {
    const {id} = c.req.valid('param');
    const admin = createServiceClient(c.env);
    const { data, error } = await admin
      .from('devices')
      .update({revoke_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoke_at', null)
      .select('id, auth_user_id')
      .maybeSigle();
    if(error || !data) throw new HTTPException(404, {message: 'DEVICE_NOT_FOUND_OR_REVOKE ' });
    if(data.auth_user_id) await admin.auth.admin.updateUserById(data.auth_user_id, {ban_duration: PERMANENT_BAN });
    return c.json({ok: true, deviceId: data.id});
  });
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  