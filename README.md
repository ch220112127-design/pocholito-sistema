# Sistema de Seguridad con IA — Pocholito

Dashboard de vigilancia con detección de rostros y placas vehiculares usando YOLOv8, Node.js y MySQL en Railway.

---

## Requisitos previos

| Herramienta | Versión mínima | Descarga |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| Python | 3.9+ | https://python.org |
| Git | cualquiera | https://git-scm.com |

---

## 1. Clonar el repositorio

```bash
git clone https://github.com/ch220112127-design/pocholito-sistema.git
cd pocholito-sistema
```

---

## 2. Configurar el servidor Node.js

```bash
cd api-conteo
npm install
```

Crea el archivo `.env` dentro de `api-conteo/`:

```env
MYSQLHOST=tu_host_de_railway
MYSQLPORT=tu_puerto_de_railway
MYSQLUSER=root
MYSQLPASSWORD=tu_password_de_railway
MYSQLDATABASE=railway
PORT=3000
```

> **¿Dónde saco esos datos?**
> En Railway → tu proyecto → servicio MySQL → pestaña "Variables". Copia cada valor.

Inicia el servidor:

```bash
node server.js
```

Abre tu navegador en `http://localhost:3000`
Usuario: `admin` | Contraseña: `pocholito2024`

---

## 3. Configurar Python (detector IA)

Instala las dependencias:

```bash
cd "Vision ML/Rostros"
pip install ultralytics opencv-python requests
```

Descarga los modelos YOLOv8 (ya deben estar en la carpeta, si no):

- `yolov8n-placas.pt` — detección de placas
- `yolov8n-face.pt` — detección de rostros

> Si no tienes `yolov8n-face.pt`, descárgalo de: https://github.com/akanametov/yolov8-face/releases

---

## 4. Configurar la cámara IP

Instala **IP Webcam** en tu celular Android (gratis en Play Store).

1. Abre la app → toca **"Start server"**
2. Anota la IP que aparece (ej: `192.168.X.X:8080`)
3. Abre `Vision ML/Rostros/Rostrospro.py` y cambia línea 15:

```python
FUENTE_VIDEO = "http://TU_IP_AQUI:8080/video"
```

4. Si usas el servidor en Railway (no local), también cambia línea 11:

```python
IP_SERVIDOR = "tu-servicio.up.railway.app"
```

Si usas local, cambia a:

```python
IP_SERVIDOR = "localhost:3000"
API_URL = f"http://{IP_SERVIDOR}/conteo"
```

---

## 5. Ejecutar el detector

```bash
cd "Vision ML/Rostros"
python Rostrospro.py
```

Selecciona modo:
- `1` → Detección de **Rostros**
- `2` → Detección de **Placas**

Presiona `Q` en la ventana de video para apagar.

---

## 6. Estructura del proyecto

```
pocholito-sistema/
├── api-conteo/
│   ├── server.js          # Servidor Express + Socket.io
│   ├── public/
│   │   └── index.html     # Dashboard web
│   ├── railway.toml       # Config de deploy en Railway
│   └── package.json
├── Vision ML/
│   └── Rostros/
│       ├── Rostrospro.py  # Detector IA (rostros + placas)
│       ├── yolov8n-placas.pt
│       └── yolov8n-face.pt
└── capturas_institucionales/  # Fotos guardadas automáticamente
```

---

## 7. Cómo funciona el sistema

1. **Python** lee el video de la cámara IP en tiempo real
2. **YOLOv8** detecta y rastrea rostros o placas
3. Cuando una detección cruza la línea de conteo → guarda foto + envía datos al servidor
4. **Node.js** guarda el registro en MySQL y emite evento por **Socket.io**
5. El **Dashboard** actualiza en tiempo real y muestra la captura

---

## 8. Funciones del Dashboard

| Función | Descripción |
|---|---|
| **Capturas recientes** | Últimas 6 fotos detectadas |
| **Registrar persona** | Asigna nombre + vehículo a un rostro desconocido |
| **Asignar a existente** | Si ya tienes a "Juan", asigna la nueva foto al mismo registro |
| **Registrar placa** | Guarda número de placa + tipo de carro + propietario |
| **Admin panel** | Agrega/elimina personas y placas conocidas manualmente |
| **Exportar CSV** | Descarga reporte con filtros aplicados |
| **Filtros** | Filtra por cámara, categoría, fecha y hora |

---

## 9. Deploy en Railway (opcional)

```bash
cd api-conteo
railway login
railway link        # selecciona tu proyecto
railway up          # sube el servidor
```

Asegúrate de que en Railway → tu servicio → **Variables** estén configuradas las variables de MySQL.

---

## Credenciales por defecto

| Campo | Valor |
|---|---|
| Usuario | `admin` |
| Contraseña | `pocholito2024` |

> Estas credenciales están en el cliente (JavaScript). Para producción real, implementar autenticación en el servidor.
