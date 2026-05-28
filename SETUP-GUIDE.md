# Plancana Supply Chain — Setup Guide

## Prerequisites

- [ ] **Docker & Docker Compose** installed
- [ ] **Git** installed
- [ ] **curl** installed
- [ ] **jq** installed (`sudo apt install jq -y`)
- [ ] Bash shell (Linux/WSL2/Mac)

---

## Step 1: Set Up Hyperledger Fabric

```bash
# Clone fabric-samples in the project directory
git clone https://github.com/hyperledger/fabric-samples.git
cd fabric-samples

# Download Fabric binaries and Docker images
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
bash install-fabric.sh docker binary

# Start the Fabric test network
cd test-network
./network.sh up createChannel -c mychannel -ca
```

**Verify:** `docker ps` should show `orderer`, `peer0.org1`, `peer0.org2`, and CA containers.

### Deploy the Chaincode

```bash
# From fabric-samples/test-network/
./network.sh deployCC -ccn agricultural-contract \
  -ccp /../../chaincode/agricultural-contract \
  -ccl javascript -c mychannel
```

**Verify:** `docker ps | grep agricultural` should show two chaincode containers (`dev-peer0.org1...` and `dev-peer0.org2...`).

> **Note:** Replace the `-ccp` path with the actual absolute path to the chaincode on your machine.

---

## Step 2: Environment Variables

Place the provided `.env` files at:

- `application/.env` — Backend configuration (database, JWT, Fabric paths, API keys)
- `frontend/plancana-nextjs/.env` — Frontend configuration (API URL, ArcGIS token)

---

## Step 3: Start the Application

```bash
# From the project root (Plancana-Supply-Chain-testing/)
docker compose -f docker-compose.dev.yml up --build
```

This will:
1. Start PostgreSQL with PostGIS
2. Run Prisma migrations and seed the database
3. Fix hostnames in the Fabric connection profile
4. Create the blockchain wallet identity
5. Start the backend API server (with nodemon for hot reload)
6. Start the Next.js frontend

**Verify:**
- Backend accessible at `http://localhost:3000`
- Frontend accessible at `http://localhost:3001`
- Backend logs show no blockchain connection errors

---

## Step 4: Access the Application

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3001 |
| API | http://localhost:3000/api |
| API Health | http://localhost:3000/api/ |

---

## Step 5: Stop the Application

Do this in different terminal

```bash
# Stop app containers (Postgres, backend, frontend)
docker compose -f docker-compose.dev.yml down

# Stop fabric
cd ./fabric-samples/test-network && ./network.sh down
```

---

## Step 6: Start back the Application

Do this in different terminal

```bash
# Start app containers (Postgres, backend, frontend)
docker compose -f docker-compose.dev.yml up

# Start fabric
cd fabric-samples/test-network && ./network.sh up createChannel -c mychannel -ca

# Start chaincode
cd ./fabric-samples/test-network && ./network.sh deployCC -ccn agricultural-contract   -ccp ../../chaincode/agricultural-contract   -ccl javascript -c mychannel
```

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `DiscoveryService: agricultural-contract error` | Chaincode not deployed | Run `./network.sh deployCC ...` from Step 1 |
| `connect ECONNREFUSED peer0.org1.example.com:7051` | Backend can't reach Fabric | Ensure Fabric network is running and `docker network ls` shows `fabric_test` |
| `User identity does not exist in wallet` | `setupIdentity.js` didn't run | Check that `fabric-samples/test-network/organizations` is volume-mounted correctly in `docker-compose.dev.yml` (see Step 1) |
| `No such image: hyperledger/fabric-nodeenv:2.5` | Missing nodeenv Docker image | `docker pull hyperledger/fabric-nodeenv:2.5` |
