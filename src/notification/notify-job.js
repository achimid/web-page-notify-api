const schedule = require('../utils/cron')
const SiteRequestModel = require('../site-request/sr-model')
const SiteExecutionModel = require('../site-execution/se-model')

const TelegramDispatcher = require('./telegram/telegram')
const EmailDispatcher = require('./email/email-dispatcher')
const WebHookDispatcher = require('./webhook/webhook-dispatcher')
const WebSocketDispacher = require('./websocket/websocket')

const { execute } = require('../site-execution/se-service')
const { templateFormat } = require('../utils/template-engine')
const { hasSimilarity } = require('../utils/text-search')


const countHash = (req, exect) => SiteExecutionModel.countDocuments({url: req.url, hashTarget: req.lastExecution.hashTarget, _id: { $ne: exect._id}})

const parseUpdateData = (exect) => {
    const updateData = { 
        isSuccess: exect.isSuccess,
        createdAt: exect.createdAt
    }

    if (exect.isSuccess) {
        updateData.hashTarget = exect.hashTarget
        updateData.extractedTarget = exect.extractedTarget
        updateData.extractedContent = exect.extractedContent
    } else {
        updateData.errorMessage = exect.errorMessage
    }
    
    return updateData    
}

const getNotifications = (site) => {
    if (site.notifications.length) return site.notifications
    if (site.userId && site.userId.notifications.length) return site.userId.notifications
    console.info('Nenhum canal de notificação encontrado', site.url)
    return []
}

const notifyChannels = (site) => {
    const notifications = getNotifications(site)
    return Promise.all(notifications.map(notf => {        

        if (notf.telegram) {
            const message = templateFormat(site, notf.template)
            return TelegramDispatcher.notifyAll(message)
        } else if (notf.email && notf.email.legth > 0) {
            const message = templateFormat(site, notf.template)
            return EmailDispatcher.sendEMail(notf.email, message)
        } else if (notf.webhook) {
            return WebHookDispatcher.send(notf.webhook, site)
        } if (notf.websocket) {
            return WebSocketDispacher.notifyWebSocket(site)
        }
        
    }))
}


// const executeNextRequest = async (req) => {
//     if (!req.then) return

//     console.info('Executando Request sequencial:', req.then.siteRequestId._id)
//     return SiteRequestModel.findById(req.then.siteRequestId._id)
//         .then(executeSiteRequests)
//         .catch(() => console.error('SiteRequestId Inválido'))
// }

const getFilter = (site) => {
    if (site.filter && site.filter.words.length > 0) return site.filter
    if (site.userId && site.userId.filter && site.userId.filter.words.length > 0) return site.userId.filter
    return false
}

const validateAndNotify = async (req, exect) => {
    
    try {
        if (!exect.isSuccess)
            throw 'Execution failed'
            
        if (req.options.onlyChanged && !req.lastExecution.hashChanged) 
            throw 'Hash not changed'

        if (req.options.onlyUnique) {
            const isUnique = await countHash(req, exect) <= 0
            if (!isUnique) throw 'Hash not unique'
        }

        const filter = getFilter(req)
        if (filter) {
            const { words, threshold} = filter
            if (!hasSimilarity(exect.extractedTarget, words, threshold)) {
                throw 'Has no similarity with filters'
            }
        }

        notifyChannels(req) // Async
        // executeNextRequest(req) // Async
    } catch (error) {
        console.info('Notification not sent: ', error)
    }            
}

const executeSiteRequests = (req) => execute(req)
    .then(async (exect) => {

        const hashChanged = req.lastExecution.hashTarget != exect.hashTarget
        Object.assign(req, { lastExecution: parseUpdateData(exect) })
        req.lastExecution.hashChanged = hashChanged

        await validateAndNotify(req, exect)

        return req.save()    
    })

const initSchedulesRequests = () => {
    if (process.env.ENABLE_JOB !== 'true') return

    console.info('Iniciando job de notificação...')

    return SiteRequestModel.find({'options.isDependency': { $ne: true}}).populate('userId').exec()
        .then(requests => requests.map(req => {
            console.info(`Starting job for ${req.url} runing each ${req.options.hitTime} minute`)
            executeSiteRequests(req)
            
            return schedule(() => { return executeSiteRequests(req) },`*/${req.options.hitTime} * * * *` )            
        }))
        .catch(() => console.log('Erro ao inicializar SchedulesRequests'))
}
    

module.exports = initSchedulesRequests