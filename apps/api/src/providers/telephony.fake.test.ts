import { describeTelephonyProviderContract } from "./telephony.contract.ts";
import { FakeTelephonyProvider } from "./telephony.fake.ts";

describeTelephonyProviderContract("Fake", () => {
  const provider = new FakeTelephonyProvider();
  return {
    provider,
    providerWithoutPurchases: new FakeTelephonyProvider({ purchasesEnabled: false }),
    sign: (url, params) => provider.sign(url, params),
    signJson: (url, rawBody) => ({ url, signature: provider.signJson(url, rawBody) }),
    seedRecording: (url, bytes) => provider.recordingAudio.set(url, bytes),
    seedCallRecord: ({ sid, ...record }) => provider.callRecords.set(sid, record),
  };
});
