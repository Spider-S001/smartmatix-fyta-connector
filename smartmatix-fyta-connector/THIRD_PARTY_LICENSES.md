# Third-Party Licenses

SmartMatix FYTA Connector makes use of the following open source packages and resources.
All licenses are reproduced below as required by their respective terms.

---

## ws (v8.18.x+)

WebSocket client and server for Node.js.  
https://github.com/websockets/ws

```
The MIT License (MIT)

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## uuid (v11.x)

RFC-compliant UUID generation for Node.js and browser.  
https://github.com/uuidjs/uuid

```
The MIT License (MIT)

Copyright (c) 2010-2020 Robert Kieffer and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Homematic IP Connect API

Node.js example plugins and API documentation by eQ-3 AG.  
This plugin is based in part on the official Node.js example code from:  
https://github.com/homematicip/connect-api

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright 2024 eQ-3 AG

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Homematic IP is a trademark of eQ-3 AG.

---

## Node.js Built-in Modules

This software uses the following modules that are part of the Node.js standard
library and are not separately installed npm packages:

- **`fs`** – File system access (reading and writing JSON data files)
- **`path`** – File path utilities
- **`https`** – HTTPS client used for all calls to the FYTA Web API

These modules are distributed as part of Node.js (https://nodejs.org), which
is licensed under the MIT License. Node.js itself is not bundled with this
software.

---

## FYTA Web API

This plugin communicates with the FYTA plant sensor cloud service at
https://web.fyta.de via its public REST API. FYTA is a third-party service
operated by FYTA GmbH. Use of the FYTA API is subject to FYTA's own Terms of
Service and Privacy Policy. No FYTA source code is included in this plugin.

FYTA is a trademark of FYTA GmbH.