import type express from "express";
import type { WalletService } from "../../wallet/WalletService";
import { sendBadRequest } from "./httpResponses";
import { getUserId, normalizeWalletAccountType } from "./requestHelpers";

export function registerUserWalletRoutes(app: express.Express, wallet: WalletService) {
  app.get("/api/wallet/accounts", (request, response) => {
    response.json(wallet.getAccounts(getUserId(request)));
  });

  app.get("/api/wallet/simulation-accounts", (request, response) => {
    response.json(wallet.listSimulationAccounts(getUserId(request)));
  });

  app.post("/api/wallet/simulation-accounts", (request, response) => {
    try {
      response.json(wallet.createSimulationAccount(getUserId(request), { name: request.body?.name }));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.patch("/api/wallet/simulation-accounts/:id", (request, response) => {
    try {
      response.json(wallet.renameSimulationAccount(getUserId(request), request.params.id, { name: request.body?.name }));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.delete("/api/wallet/simulation-accounts/:id", (request, response) => {
    try {
      response.json(wallet.deleteSimulationAccount(getUserId(request), request.params.id));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/simulation-accounts/:id/reset", (request, response) => {
    try {
      response.json(wallet.resetSimulationAccount(getUserId(request), request.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "模拟账户每 24 小时只能重置一次。") {
        response.status(429).json({ message });
        return;
      }
      sendBadRequest(response, error);
    }
  });

  app.get("/api/wallet/overview", (request, response) => {
    response.json(wallet.getOverview(getUserId(request)));
  });

  app.get("/api/wallet/recent-activities", (request, response) => {
    response.json(wallet.listRecentActivities(getUserId(request)));
  });

  app.get("/api/wallet/funding-orders", (request, response) => {
    response.json(
      wallet.listFundingOrders(getUserId(request), {
        type: typeof request.query.type === "string" ? request.query.type : undefined,
        limit: Number(request.query.limit),
        page: Number(request.query.page),
        pageSize: Number(request.query.pageSize),
      }),
    );
  });

  app.get("/api/wallet/onchain-records", (request, response) => {
    response.json(
      wallet.listOnchainRecords(getUserId(request), {
        limit: Number(request.query.limit),
        page: Number(request.query.page),
        pageSize: Number(request.query.pageSize),
      }),
    );
  });

  app.post("/api/wallet/external/challenge", (request, response) => {
    try {
      response.json(
        wallet.createExternalWalletChallenge(getUserId(request), {
          walletAddress: request.body?.walletAddress,
          network: request.body?.network,
          provider: request.body?.provider,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/external-wallet/challenge", (request, response) => {
    try {
      response.json(
        wallet.createExternalWalletChallenge(getUserId(request), {
          walletAddress: request.body?.walletAddress,
          network: request.body?.network,
          provider: request.body?.provider,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/external/bind", (request, response) => {
    try {
      response.json(
        wallet.bindExternalWallet(getUserId(request), {
          challengeId: request.body?.challengeId,
          walletAddress: request.body?.walletAddress,
          signature: request.body?.signature,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/external-wallet/bind", (request, response) => {
    try {
      response.json(
        wallet.bindExternalWallet(getUserId(request), {
          challengeId: request.body?.challengeId,
          walletAddress: request.body?.walletAddress,
          signature: request.body?.signature,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/wallet/external", (request, response) => {
    response.json(wallet.getExternalWalletBinding(getUserId(request)));
  });

  app.get("/api/wallet/external-wallet", (request, response) => {
    response.json(wallet.getExternalWalletBinding(getUserId(request)));
  });

  app.delete("/api/wallet/external", (request, response) => {
    response.json(wallet.unbindExternalWallet(getUserId(request)));
  });

  app.delete("/api/wallet/external-wallet", (request, response) => {
    response.json(wallet.unbindExternalWallet(getUserId(request)));
  });

  app.get("/api/wallet/deposit-address", (request, response) => {
    try {
      response.json(wallet.getDepositAddress(getUserId(request)));
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/wallet/deposits", (request, response) => {
    response.json(wallet.listOnchainDeposits(getUserId(request)));
  });

  app.get("/api/wallet/ledger", (request, response) => {
    response.json(wallet.listLedger(getUserId(request)));
  });

  app.get("/api/wallet/transfers", (request, response) => {
    response.json(wallet.listTransfers(getUserId(request)));
  });

  app.post("/api/wallet/transfer", (request, response) => {
    try {
      response.json(
        wallet.transfer(
          getUserId(request),
          normalizeWalletAccountType(request.body?.from),
          normalizeWalletAccountType(request.body?.to),
          Number(request.body?.amount),
          request.body?.remark,
        ),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/account-transfer", (request, response) => {
    try {
      response.json(
        wallet.accountTransfer(
          getUserId(request),
          normalizeWalletAccountType(request.body?.from),
          normalizeWalletAccountType(request.body?.to),
          Number(request.body?.amount),
          request.body?.remark,
        ),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/internal-transfer", (request, response) => {
    try {
      response.json(
        wallet.internalTransfer(getUserId(request), {
          recipient: request.body?.recipient,
          amount: Number(request.body?.amount),
          remark: request.body?.remark,
          clientRequestId: request.body?.clientRequestId,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.post("/api/wallet/withdrawals", (request, response) => {
    try {
      response.json(
        wallet.createWithdrawal(getUserId(request), {
          amount: Number(request.body?.amount),
          network: request.body?.network,
          walletAddress: request.body?.walletAddress,
          remark: request.body?.remark,
        }),
      );
    } catch (error) {
      sendBadRequest(response, error);
    }
  });

  app.get("/api/wallet/withdrawals", (request, response) => {
    response.json(wallet.listWithdrawals(getUserId(request)));
  });
}
