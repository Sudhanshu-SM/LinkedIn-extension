document.addEventListener('DOMContentLoaded', () => {
    // Load existing settings
    chrome.storage.local.get(['zohoClientId', 'zohoClientSecret', 'zohoRefreshToken', 'zohoDomain', 'zohoApiDomain'], (result) => {
        if (result.zohoClientId) document.getElementById('clientId').value = result.zohoClientId;
        if (result.zohoClientSecret) document.getElementById('clientSecret').value = result.zohoClientSecret;
        if (result.zohoRefreshToken) document.getElementById('refreshToken').value = result.zohoRefreshToken;
        if (result.zohoDomain) document.getElementById('domain').value = result.zohoDomain;
        if (result.zohoApiDomain) document.getElementById('apiDomain').value = result.zohoApiDomain;
    });

    // Save settings
    document.getElementById('saveBtn').addEventListener('click', () => {
        const clientId = document.getElementById('clientId').value.trim();
        const clientSecret = document.getElementById('clientSecret').value.trim();
        const refreshToken = document.getElementById('refreshToken').value.trim();
        let domain = document.getElementById('domain').value.trim();
        let apiDomain = document.getElementById('apiDomain').value.trim();

        if (!domain.startsWith('http')) domain = 'https://' + domain;
        if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;

        chrome.storage.local.set({
            zohoClientId: clientId,
            zohoClientSecret: clientSecret,
            zohoRefreshToken: refreshToken,
            zohoDomain: domain,
            zohoApiDomain: apiDomain
        }, () => {
            const statusMsg = document.getElementById('statusMsg');
            statusMsg.style.display = 'block';
            setTimeout(() => {
                statusMsg.style.display = 'none';
            }, 3000);
        });
    });
});
