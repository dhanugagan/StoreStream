import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  iterations: 20,
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const payload = JSON.stringify({
    customerName: `Load Tester ${__VU}`,
    customerEmail: `vu${__VU}@example.in`,
    city: 'Bengaluru',
    shippingAddress: 'Indiranagar, Bengaluru',
    paymentMethod: 'UPI_SIMULATION',
    items: [{ productId: 'prod_earphones', qty: 1 }],
  });

  const res = http.post(`${BASE_URL}/api/orders/checkout`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'valid status 201 or 409 conflict': (r) => r.status === 201 || r.status === 409,
  });
}
