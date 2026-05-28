const { Wallets } = require('fabric-network');
const path = require('path');
const fs = require('fs');

async function setupIdentity() {
    try {
        const walletPath = path.join(process.cwd(), 'wallet');
        const wallet = await Wallets.newFileSystemWallet(walletPath);

        // Use ORGANIZATIONS_PATH env var if set, otherwise default to ./organizations relative to cwd
        const orgBasePath = process.env.ORGANIZATIONS_PATH || path.join(process.cwd(), 'organizations');
        const certPath = path.join(orgBasePath, 'peerOrganizations', 'org1.example.com', 'users', 'User1@org1.example.com', 'msp', 'signcerts', 'cert.pem');
        
        const keyDir = path.join(orgBasePath, 'peerOrganizations', 'org1.example.com', 'users', 'User1@org1.example.com', 'msp', 'keystore');

        console.log('✅ Certificate found at:', certPath);
        console.log('🔍 Looking for private key in:', keyDir);

        // Check keystore directory
        if (!fs.existsSync(keyDir)) {
            console.log('❌ Keystore directory not found');
            return;
        }

        const keyFiles = fs.readdirSync(keyDir);
        console.log('🔑 Available key files:', keyFiles);

        if (keyFiles.length === 0) {
            console.log('❌ No private key files found');
            return;
        }

        // Read certificate and private key
        const certificate = fs.readFileSync(certPath).toString();
        const privateKey = fs.readFileSync(path.join(keyDir, keyFiles[0])).toString();

        console.log('📜 Certificate loaded successfully');
        console.log('🔐 Private key loaded:', keyFiles[0]);

        // Create identity
        const identity = {
            credentials: {
                certificate: certificate,
                privateKey: privateKey,
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };

        await wallet.put('appUser', identity);
        console.log('🎉 Successfully created appUser identity!');
        console.log('📁 Wallet location:', walletPath);

        // Verify the identity was created
        const savedIdentity = await wallet.get('appUser');
        if (savedIdentity) {
            console.log('✅ Identity verification: appUser exists in wallet');
        } else {
            console.log('❌ Identity verification failed');
        }

    } catch (error) {
        console.error('❌ Failed to setup identity:', error.message);
        console.error('Full error:', error);
    }
}

setupIdentity();
