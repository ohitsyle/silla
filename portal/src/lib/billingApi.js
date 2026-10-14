/**
 * Plans, subscriptions, invoices and payments — for the storefront, the
 * buyer's billing page and the staff console. Same service, token and
 * error shape as lib/vendorApi.js, whose request() it shares.
 *
 * Owner: the billing work.
 */
import { request } from "./vendorApi.js";

export const billingApi = {};
