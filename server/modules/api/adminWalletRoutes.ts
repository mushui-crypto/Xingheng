import type express from "express";
import type { WalletService } from "../../wallet/WalletService";
import { sendBadRequest } from "./httpResponses";

export function registerAdminWalletRoutes(app: express.Express, wallet: WalletService) {
  app.get("/api/admin/wallet/accounts", (_request, response) => {
    response.json(wallet.listAccounts());
  });

  app.get("/api/admin/wallet/deposit-addresses", (_request, response) => {
    response.json(wallet.listDepositAddresses());
  });

  app.get("/api/admin/wallet/deposits", (_request, response) => {
    response.json(wallet.listOnchainDeposits());
  });

  app.get("/api/admin/wallet/ledger", (_request, response) => {
    response.json(wallet.listLedger());
  });

  app.get("/api/admin/wallet/transfers", (_request, response) => {
    response.json(wallet.listTransfers());
  });

  app.get("/api/admin/wallet/withdrawals", (_request, response) => {
    response.json(wallet.listWithdrawals());
  });

  app.get("/api/admin/wallet/external-bindings", (_request, response) => {
    response.json(wallet.listExternalWalletBindings());
  });

  app.post("/api/admin/wallet/deposit", (request, response) => {
    try {
      response.json(wallet.deposit(String(request.body?.userId ?? "demo-user"), Number(request.body?.amount), request.body?.remark));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/admin/wallet/onchain/scan", async (_request, response) => {
    try {
      response.json(await wallet.scanDeposits());
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/admin/wallet/withdrawals/confirm", async (_request, response) => {
    try {
      response.json(await wallet.confirmWithdrawals());
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/admin/wallet/withdrawals/:id/approve", async (request, response) => {
    try {
      response.json(await wallet.approveWithdrawal(request.params.id, request.body?.reviewNote));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/admin/wallet/withdrawals/:id/reject", (request, response) => {
    try {
      response.json(wallet.rejectWithdrawal(request.params.id, request.body?.reviewNote));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });
}
